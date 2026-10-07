import { describe, expect, it, vi } from 'vitest';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createRunWriter } from '../../src/logstore/run-writer.ts';

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('Run writer backpressure accounting', () => {
	it('counts every queued line before the first disk write completes', async () => {
		const disk = deferred();
		const stream = { pause: vi.fn(), resume: vi.fn() };
		const appendFile = async () => {
			await disk.promise;
		};
		const queue = createAppendQueue({ appendFile }, { stream });
		const writer = createRunWriter({
			runId: 'run-backpressure',
			paths: createLogstorePaths(process.cwd()),
			queue,
			fs: { appendFile, mkdirSync: () => {}, fileLenSync: () => null },
		});
		const line = new Uint8Array(1024 * 1024);
		const writes = Array.from({ length: 9 }, () => writer.appendRawLine(line));
		try {
			await new Promise((done) => setTimeout(done, 0));
			expect(queue.pendingBytes).toBe(9 * (line.byteLength + 1));
			expect(stream.pause).toHaveBeenCalledTimes(1);
			expect(queue.isPaused).toBe(true);
		} finally {
			disk.resolve();
			await Promise.all(writes);
		}
		expect(queue.pendingBytes).toBe(0);
		expect(stream.resume).toHaveBeenCalledTimes(1);
	});

	it('keeps raw and event bytes accounted until the low watermark is reached', async () => {
		const gates = [deferred(), deferred(), deferred()];
		let started = 0;
		const stream = { pause: vi.fn(), resume: vi.fn() };
		const appendFile = async () => {
			await gates[started++]?.promise;
		};
		const queue = createAppendQueue(
			{ appendFile },
			{ stream, highWatermarkBytes: 8, lowWatermarkBytes: 4 },
		);
		const writer = createRunWriter({
			runId: 'run-mixed',
			paths: createLogstorePaths(process.cwd()),
			queue,
			fs: { appendFile, mkdirSync: () => {}, fileLenSync: () => null },
		});
		const a = writer.appendRawLine(new Uint8Array(2));
		const b = writer.appendEventLine(new Uint8Array(2));
		const c = writer.appendRawLine(new Uint8Array(2));
		try {
			expect(queue.pendingBytes).toBe(9);
			expect(stream.pause).toHaveBeenCalledTimes(1);
			gates[0]?.resolve();
			expect((await a).byteOffset).toBe(0);
			expect(queue.pendingBytes).toBe(6);
			expect(stream.resume).not.toHaveBeenCalled();
			gates[1]?.resolve();
			expect((await b).byteOffset).toBe(0);
			expect(queue.pendingBytes).toBe(3);
			expect(stream.resume).toHaveBeenCalledTimes(1);
		} finally {
			for (const gate of gates) gate.resolve();
			await Promise.all([a, b, c]);
		}
		expect((await c).byteOffset).toBe(3);
		expect(queue.pendingBytes).toBe(0);
	});

	it.each(['prepare', 'append'] as const)(
		'releases bytes after %s failure and keeps later writes usable',
		async (failure) => {
			let fail = true;
			const appendFile = async () => {
				if (failure === 'append' && fail) throw new Error('disk failure');
			};
			const queue = createAppendQueue({ appendFile });
			const writer = createRunWriter({
				runId: 'run-recovery',
				paths: createLogstorePaths(process.cwd()),
				queue,
				fs: {
					appendFile,
					mkdirSync: () => {
						if (failure === 'prepare' && fail) throw new Error('directory failure');
					},
					fileLenSync: () => null,
				},
			});
			await expect(writer.appendRawLine(new Uint8Array(2))).rejects.toThrow('failure');
			expect(queue.pendingBytes).toBe(0);
			fail = false;
			expect((await writer.appendRawLine(new Uint8Array(2))).byteOffset).toBe(0);
			await writer.flush();
			expect(queue.pendingBytes).toBe(0);
		},
	);
});
