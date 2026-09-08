import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import {
	type RunWriterInitialState,
	createRunWriter,
	resumeRunWriterState,
} from '../../src/logstore/run-writer.ts';

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBaseDir(): string {
	const base = mkdtempSync(join(tmpdir(), 'ags-logwriter-'));
	tmpDirs.push(base);
	return base;
}

const TEST_SEGMENT_LIMIT = 1024;

describe('RunLogWriter (E-149 / R1)', () => {
	it('rotates to the next segment file when the limit is hit and records segment boundaries', async () => {
		const baseDir = makeBaseDir();
		const paths = createLogstorePaths(baseDir);
		const fs = createNodeLogFileSystem();
		const { appendFile } = await import('node:fs/promises');
		const queue = { append: appendFile, drain: async () => {}, pendingBytes: 0 };
		const writer = createRunWriter({
			runId: 'run-1',
			paths,
			queue: queue as never,
			fs,
			segmentSizeLimitBytes: TEST_SEGMENT_LIMIT,
		});

		const line = new Uint8Array(400).fill(65);
		await writer.appendRawLine(line);
		await writer.appendRawLine(line);
		await writer.appendRawLine(line);
		await writer.flush();

		const seg0 = paths.segmentPath('run-1', 'raw', 0);
		const seg1 = paths.segmentPath('run-1', 'raw', 1);
		const { statSync } = await import('node:fs');
		const size0 = statSync(seg0).size;
		const size1 = statSync(seg1).size;
		// line(400) + LF(1) = 401 bytes each. limit=1024. seg0 fits two lines (802); third overflows → 802+401=1203 > 1024.
		expect(size0).toBe(802);
		expect(size1).toBe(401);
	});

	it('R1: rebuilds a writer for an existing run without overwriting prior bytes', async () => {
		const baseDir = makeBaseDir();
		const paths = createLogstorePaths(baseDir);
		const fs = createNodeLogFileSystem();
		const { appendFile } = await import('node:fs/promises');
		const queue = { append: appendFile, drain: async () => {}, pendingBytes: 0 };

		const writerA = createRunWriter({ runId: 'run-1', paths, queue: queue as never, fs });
		await writerA.appendEventLine(new Uint8Array([65, 66, 67])); // ABC
		await writerA.flush();

		const initialState: RunWriterInitialState = resumeRunWriterState(fs, paths, 'run-1');
		// Bypass the registry: a fresh writer for the same run must resume at the existing tail,
		// not at byte 0 of segment 0 (R1).
		expect(initialState.events?.fileSeq).toBe(0);
		expect(initialState.events?.byteEnd).toBe(4); // ABC + LF

		const writerB = createRunWriter({
			runId: 'run-1',
			paths,
			queue: queue as never,
			fs,
			initialState,
		});
		await writerB.appendEventLine(new Uint8Array([68, 69])); // DE
		await writerB.flush();

		const seg0 = paths.segmentPath('run-1', 'events', 0);
		const { statSync, readFileSync } = await import('node:fs');
		expect(statSync(seg0).size).toBe(7); // 4 + 2 + 1
		const bytes = readFileSync(seg0);
		// bytes must be ABC\nDE\n (LF at the right place), not ABC\n\nDE\n (the bug).
		expect(Array.from(bytes)).toEqual([65, 66, 67, 0x0a, 68, 69, 0x0a]);
	});

	it('R1: rebuilds across rotated segments without rewinding fileSeq', async () => {
		const baseDir = makeBaseDir();
		const paths = createLogstorePaths(baseDir);
		const fs = createNodeLogFileSystem();
		const { appendFile } = await import('node:fs/promises');
		const queue = { append: appendFile, drain: async () => {}, pendingBytes: 0 };

		const writerA = createRunWriter({
			runId: 'run-rotate',
			paths,
			queue: queue as never,
			fs,
			segmentSizeLimitBytes: 8, // 4 bytes per line + LF
		});
		await writerA.appendEventLine(new Uint8Array([65, 65, 65])); // 3 bytes + LF = 4
		await writerA.appendEventLine(new Uint8Array([66, 66, 66])); // fits in seg0 (8 bytes total)
		await writerA.appendEventLine(new Uint8Array([67, 67, 67])); // rotates to seg1
		await writerA.flush();

		const state = resumeRunWriterState(fs, paths, 'run-rotate');
		expect(state.events?.fileSeq).toBe(1);
		expect(state.events?.byteEnd).toBe(4);

		// Resume must keep fileSeq=1, NOT reset to 0.
		const writerB = createRunWriter({
			runId: 'run-rotate',
			paths,
			queue: queue as never,
			fs,
			initialState: state,
		});
		const result = await writerB.appendEventLine(new Uint8Array([68, 68, 68]));
		expect(result.fileSeq).toBe(1);
		expect(result.byteOffset).toBe(4);
	});
});
