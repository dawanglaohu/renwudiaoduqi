import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createRunWriter } from '../../src/logstore/run-writer.ts';

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBase(): string {
	const base = mkdtempSync(join(tmpdir(), 'ags-runwriter-'));
	tmpDirs.push(base);
	return base;
}

async function makeWriter(runId: string, limit?: number) {
	const baseDir = makeBase();
	const paths = createLogstorePaths(baseDir);
	const fs = createNodeLogFileSystem();
	const { appendFile } = await import('node:fs/promises');
	const queue = { append: appendFile, drain: async () => {}, pendingBytes: 0 };
	const writer = createRunWriter({
		runId,
		paths,
		queue: queue as never,
		fs,
		...(limit !== undefined ? { segmentSizeLimitBytes: limit } : {}),
	});
	return { writer, paths, fs, baseDir };
}

describe('RunLogWriter lifecycle (R1)', () => {
	it('creates the run directory on the first write', async () => {
		const { writer, paths } = await makeWriter('run-dir');
		const { existsSync } = await import('node:fs');
		expect(existsSync(paths.runDir('run-dir'))).toBe(false);
		await writer.appendRawLine(new Uint8Array([65]));
		await writer.flush();
		expect(existsSync(paths.runDir('run-dir'))).toBe(true);
	});

	it('serializes appends and reports monotonically increasing byte offsets', async () => {
		const { writer } = await makeWriter('run-seq');
		const a = await writer.appendEventLine(new Uint8Array([65]));
		const b = await writer.appendEventLine(new Uint8Array([66]));
		const c = await writer.appendEventLine(new Uint8Array([67]));
		await writer.flush();
		expect([a, b, c].map((r) => r.byteOffset)).toEqual([0, 2, 4]);
		expect([a, b, c].map((r) => r.byteLen)).toEqual([2, 2, 2]);
	});

	it('reports the closed segment on rotation and continues on the new file', async () => {
		const { writer } = await makeWriter('run-rot', 6); // 2 bytes + LF = 3; two lines = 6
		await writer.appendEventLine(new Uint8Array([65, 65])); // 3 bytes
		await writer.appendEventLine(new Uint8Array([66, 66])); // 3 bytes → fills seg0 (6)
		const c = await writer.appendEventLine(new Uint8Array([67, 67])); // would be 9 > 6 → rotate
		const d = await writer.appendEventLine(new Uint8Array([68, 68]));
		await writer.flush();
		expect(c.fileSeq).toBe(1); // the line that crossed the limit landed on segment 1
		expect(c.byteOffset).toBe(0);
		expect(c.closedSegment).not.toBeNull();
		expect(c.closedSegment?.fileSeq).toBe(0);
		expect(c.closedSegment?.byteEnd).toBe(6);
		expect(d.fileSeq).toBe(1);
		expect(d.byteOffset).toBe(3);
		expect(d.closedSegment).toBeNull();
	});
});
