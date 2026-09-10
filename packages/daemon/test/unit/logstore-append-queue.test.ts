import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import {
	DEFAULT_HIGH_WATERMARK_BYTES,
	DEFAULT_LOW_WATERMARK_BYTES,
	createAppendQueue,
} from '../../src/logstore/append-queue.ts';

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('AppendQueue', () => {
	it('serializes appends in order and tracks pending bytes', async () => {
		const order: number[] = [];
		const queue = createAppendQueue({
			appendFile: async (_path, data) => {
				await new Promise((r) => setTimeout(r, 5));
				order.push(Number(data[0]));
			},
		});

		const p1 = queue.append('/tmp/a', new Uint8Array([1]));
		const p2 = queue.append('/tmp/a', new Uint8Array([2]));
		expect(queue.pendingBytes).toBe(2);
		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
		expect(queue.pendingBytes).toBe(0);
	});

	it('survives a failed append and keeps the chain alive', async () => {
		const queue = createAppendQueue({
			appendFile: async (_path, data) => {
				if (data[0] === 2) throw new Error('disk gone');
			},
		});
		await expect(queue.append('/a', new Uint8Array([1]))).resolves.toBeUndefined();
		await expect(queue.append('/a', new Uint8Array([2]))).rejects.toThrow('disk gone');
		await expect(queue.append('/a', new Uint8Array([3]))).resolves.toBeUndefined();
	});

	it('triggers pause when pending bytes exceed 8 MiB and resumes when falling back to 4 MiB (AC 3)', async () => {
		let resolveFirstWrite: (() => void) | undefined;
		let resolveSecondWrite: (() => void) | undefined;
		let writeCount = 0;

		const queue = createAppendQueue({
			appendFile: async (_path, _data) => {
				writeCount += 1;
				if (writeCount === 1) {
					await new Promise<void>((resolve) => {
						resolveFirstWrite = resolve;
					});
				} else if (writeCount === 2) {
					await new Promise<void>((resolve) => {
						resolveSecondWrite = resolve;
					});
				}
			},
		});

		expect(queue.highWatermarkBytes).toBe(DEFAULT_HIGH_WATERMARK_BYTES); // 8 MiB
		expect(queue.lowWatermarkBytes).toBe(DEFAULT_LOW_WATERMARK_BYTES); // 4 MiB

		const mockStream = {
			pause: vi.fn(),
			resume: vi.fn(),
		};
		queue.attachStream(mockStream);

		const onPause = vi.fn();
		const onResume = vi.fn();
		queue.onPause(onPause);
		queue.onResume(onResume);

		// 1. Append exactly 8 MiB -> not exceeded yet (pending === 8 MiB)
		const eightMib = new Uint8Array(DEFAULT_HIGH_WATERMARK_BYTES);
		const p1 = queue.append('/tmp/log.raw', eightMib);
		expect(queue.pendingBytes).toBe(DEFAULT_HIGH_WATERMARK_BYTES);
		expect(queue.isPaused).toBe(false);
		expect(mockStream.pause).not.toHaveBeenCalled();
		expect(onPause).not.toHaveBeenCalled();

		// 2. Append 1 more byte -> pending exceeds 8 MiB!
		const oneByte = new Uint8Array(1);
		const p2 = queue.append('/tmp/log.raw', oneByte);
		expect(queue.pendingBytes).toBe(DEFAULT_HIGH_WATERMARK_BYTES + 1);
		expect(queue.isPaused).toBe(true);
		expect(mockStream.pause).toHaveBeenCalledTimes(1);
		expect(onPause).toHaveBeenCalledTimes(1);

		// Wait for first appendFile to begin executing
		await tick();
		expect(resolveFirstWrite).toBeDefined();

		// 3. Complete the first write (8 MiB released, 1 byte remains)
		// Pending bytes drops to 1 byte, which is <= 4 MiB (low watermark) -> resumes!
		resolveFirstWrite?.();
		await p1;

		expect(queue.pendingBytes).toBe(1);
		expect(queue.isPaused).toBe(false);
		expect(mockStream.resume).toHaveBeenCalledTimes(1);
		expect(onResume).toHaveBeenCalledTimes(1);

		// Wait for second write to begin
		await tick();
		expect(resolveSecondWrite).toBeDefined();

		// 4. Complete second write -> pending 0
		resolveSecondWrite?.();
		await p2;
		expect(queue.pendingBytes).toBe(0);
	});

	it('maintains pause state with hysteresis while pending bytes are between 4 MiB and 8 MiB (AC 3)', async () => {
		const resolvers: Array<() => void> = [];

		const queue = createAppendQueue(
			{
				appendFile: async (_path, _data) => {
					await new Promise<void>((resolve) => {
						resolvers.push(resolve);
					});
				},
			},
			{
				highWatermarkBytes: 8000,
				lowWatermarkBytes: 4000,
			},
		);

		const mockStream = {
			pause: vi.fn(),
			resume: vi.fn(),
		};
		queue.attachStream(mockStream);

		// 1. Append 6000 bytes (between 4000 and 8000) -> initially unpaused, stays unpaused
		const p1 = queue.append('/tmp/log.raw', new Uint8Array(6000));
		expect(queue.isPaused).toBe(false);
		expect(mockStream.pause).not.toHaveBeenCalled();

		// 2. Append 3000 bytes -> pending becomes 9000 (> 8000 high watermark) -> pauses!
		const p2 = queue.append('/tmp/log.raw', new Uint8Array(3000));
		expect(queue.isPaused).toBe(true);
		expect(mockStream.pause).toHaveBeenCalledTimes(1);

		// 3. Append 1000 bytes -> pending becomes 10000 -> stays paused (no duplicate pause call)
		const p3 = queue.append('/tmp/log.raw', new Uint8Array(1000));
		expect(queue.isPaused).toBe(true);
		expect(mockStream.pause).toHaveBeenCalledTimes(1);

		// Wait for first append to enter appendFile
		await tick();
		expect(resolvers.length).toBeGreaterThanOrEqual(1);

		// 4. Release first write (6000 bytes) -> pending drops from 10000 to 4000 (<= 4000 low watermark)
		resolvers[0]?.();
		await p1;

		expect(queue.pendingBytes).toBe(4000);
		expect(queue.isPaused).toBe(false);
		expect(mockStream.resume).toHaveBeenCalledTimes(1);

		// Allow second write to start
		await tick();
		resolvers[1]?.();
		await p2;

		// Allow third write to start
		await tick();
		resolvers[2]?.();
		await p3;

		expect(queue.pendingBytes).toBe(0);
	});

	it('immediately pauses a stream attached while queue is already in paused state', async () => {
		let resolveWrite: (() => void) | undefined;
		const queue = createAppendQueue(
			{
				appendFile: async () => {
					await new Promise<void>((resolve) => {
						resolveWrite = resolve;
					});
				},
			},
			{
				highWatermarkBytes: 100,
				lowWatermarkBytes: 50,
			},
		);

		// Push over high watermark
		const p = queue.append('/tmp/log.raw', new Uint8Array(150));
		expect(queue.isPaused).toBe(true);

		// Late-attached stream must immediately receive pause()
		const lateStream = {
			pause: vi.fn(),
			resume: vi.fn(),
		};
		const unbind = queue.attachStream(lateStream);
		expect(lateStream.pause).toHaveBeenCalledTimes(1);

		await tick();
		// Drain below low watermark -> resumes
		resolveWrite?.();
		await p;
		expect(queue.isPaused).toBe(false);
		expect(lateStream.resume).toHaveBeenCalledTimes(1);

		unbind();
	});

	it('validates that lowWatermarkBytes cannot exceed highWatermarkBytes', () => {
		expect(() =>
			createAppendQueue(
				{ appendFile: async () => {} },
				{ highWatermarkBytes: 1000, lowWatermarkBytes: 2000 },
			),
		).toThrowError(AppError);
	});

	it('drain() waits for all pending appends and resets backpressure', async () => {
		let resolveWrite: (() => void) | undefined;
		const queue = createAppendQueue(
			{
				appendFile: async () => {
					await new Promise<void>((resolve) => {
						resolveWrite = resolve;
					});
				},
			},
			{
				highWatermarkBytes: 100,
				lowWatermarkBytes: 50,
			},
		);

		void queue.append('/tmp/log.raw', new Uint8Array(200));
		expect(queue.isPaused).toBe(true);

		setTimeout(() => resolveWrite?.(), 10);
		await queue.drain();

		expect(queue.pendingBytes).toBe(0);
		expect(queue.isPaused).toBe(false);
	});
});
