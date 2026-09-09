import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogFileSystem } from '../../src/logstore/contract.ts';
import { toFilesystemError } from '../../src/logstore/fs-errors.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import {
	calculateDiskUsage,
	createLogstorePrimitives,
	deleteByPath,
	isPathWithinWhitelist,
	truncate,
} from '../../src/logstore/primitives.ts';

/**
 * A LogFileSystem whose one mutating call fails with a busy code, either raw or
 * wrapped the way createNodeLogFileSystem wraps it. Real EBUSY needs a second
 * process holding the file, which no CI runner can stage deterministically.
 */
function busyFs(
	method: 'deleteFile' | 'truncateFile',
	code: 'EBUSY' | 'EPERM',
	wrapped: boolean,
): LogFileSystem {
	const fail = async (): Promise<void> => {
		const native = Object.assign(new Error('resource busy or locked'), { code });
		throw wrapped ? toFilesystemError(native, 'Failed.') : native;
	};
	const noop = async (): Promise<void> => {};
	return {
		mkdirSync() {},
		listDirectory: () => [],
		appendFile: noop,
		readFile: async () => new Uint8Array(0),
		readRange: async () => new Uint8Array(0),
		fileLenSync: () => 1024,
		deleteFile: method === 'deleteFile' ? fail : noop,
		truncateFile: method === 'truncateFile' ? fail : noop,
		statfs: async () => ({ bavail: 1, bsize: 4096, blocks: 1 }),
	};
}

describe('logstore primitives (M1-T5)', () => {
	let testDir: string;
	let whitelistRoot: string;
	let fs: LogFileSystem;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'sched-disk-prim-'));
		whitelistRoot = join(testDir, 'runs');
		fs = createNodeLogFileSystem();
		fs.mkdirSync(whitelistRoot);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe('E-206: whitelist directory restriction & violation logging', () => {
		it('allows files located inside the whitelist root', () => {
			expect(isPathWithinWhitelist(join(whitelistRoot, 'run-1', 'raw.log'), whitelistRoot)).toBe(
				true,
			);
		});

		it('rejects the whitelist root itself to prevent wiping the entire store', () => {
			expect(isPathWithinWhitelist(whitelistRoot, whitelistRoot)).toBe(false);
		});

		it('rejects path traversal attempts pointing outside the whitelist root', () => {
			expect(isPathWithinWhitelist(join(whitelistRoot, '..', 'app.db'), whitelistRoot)).toBe(false);
			expect(
				isPathWithinWhitelist(
					join(whitelistRoot, 'run-1', '..', '..', 'secret.txt'),
					whitelistRoot,
				),
			).toBe(false);
		});

		it('rejects paths on another drive or root directory', () => {
			expect(isPathWithinWhitelist('/etc/passwd', whitelistRoot)).toBe(false);
			expect(isPathWithinWhitelist('C:\\Windows\\System32\\calc.exe', whitelistRoot)).toBe(false);
		});

		it('rejects protected database and system files even inside the whitelist root', () => {
			for (const name of ['app.db', 'app.db-wal', 'pairing-code.txt', 'instance.lock']) {
				expect(isPathWithinWhitelist(join(whitelistRoot, name), whitelistRoot)).toBe(false);
			}
		});

		it('deleteByPath refuses paths outside the whitelist and writes a security violation log', async () => {
			const violations: string[] = [];
			const outsidePath = join(testDir, 'sensitive-outside.txt');
			writeFileSync(outsidePath, 'secret data');

			const res = await deleteByPath(outsidePath, {
				whitelistRoot,
				fs,
				logViolation: (msg) => violations.push(msg),
			});

			expect(res).toMatchObject({ ok: false, code: 'E_FORBIDDEN', retryable: false });
			expect(violations).toHaveLength(1);
			expect(violations[0]).toContain('[SECURITY_VIOLATION]');
			expect(violations[0]).toContain('sensitive-outside.txt');
			expect(fs.fileLenSync(outsidePath)).toBeGreaterThan(0);
		});

		it('truncate refuses paths outside the whitelist and writes a security violation log', async () => {
			const violations: string[] = [];
			const outsidePath = join(testDir, 'another-outside.txt');
			writeFileSync(outsidePath, 'some data to truncate');

			const res = await truncate(outsidePath, 0, {
				whitelistRoot,
				fs,
				logViolation: (msg) => violations.push(msg),
			});

			expect(res).toMatchObject({ ok: false, code: 'E_FORBIDDEN', retryable: false });
			expect(violations).toHaveLength(1);
			expect(violations[0]).toContain('[SECURITY_VIOLATION]');
			expect(fs.fileLenSync(outsidePath)).toBeGreaterThan(0);
		});
	});

	describe('E-204: a target still being read (EBUSY) returns a retryable result, never throws', () => {
		it('deleteByPath reports retryable EBUSY for a raw EBUSY from the adapter', async () => {
			const targetFile = join(whitelistRoot, 'run-busy', 'raw.log');
			const res = await deleteByPath(targetFile, {
				whitelistRoot,
				fs: busyFs('deleteFile', 'EBUSY', false),
			});
			expect(res).toEqual({
				ok: false,
				code: 'EBUSY',
				retryable: true,
				path: targetFile,
				message: expect.any(String),
			});
		});

		it('deleteByPath reports retryable EBUSY for the EPERM the real adapter wraps on Windows', async () => {
			const targetFile = join(whitelistRoot, 'run-busy', 'raw.log');
			const res = await deleteByPath(targetFile, {
				whitelistRoot,
				fs: busyFs('deleteFile', 'EPERM', true),
			});
			expect(res).toMatchObject({ ok: false, code: 'EBUSY', retryable: true });
		});

		it('truncate reports retryable EBUSY when the file is locked', async () => {
			const targetFile = join(whitelistRoot, 'run-busy', 'events.ndjson');
			const res = await truncate(targetFile, 0, {
				whitelistRoot,
				fs: busyFs('truncateFile', 'EBUSY', true),
			});
			expect(res).toMatchObject({ ok: false, code: 'EBUSY', retryable: true, path: targetFile });
		});
	});

	describe('successful deletion and truncation', () => {
		it('deletes a file inside the whitelist and reports bytesFreed', async () => {
			const runDir = join(whitelistRoot, 'run-ok');
			fs.mkdirSync(runDir);
			const targetFile = join(runDir, 'raw.log');
			writeFileSync(targetFile, 'content 12345');

			const res = await deleteByPath(targetFile, { whitelistRoot, fs });

			expect(res).toEqual({ ok: true, path: targetFile, bytesFreed: 13 });
			expect(fs.fileLenSync(targetFile)).toBeNull();
		});

		it('deletes a whole run directory and sums its segment files into bytesFreed', async () => {
			const runDir = join(whitelistRoot, 'run-dir');
			fs.mkdirSync(runDir);
			writeFileSync(join(runDir, 'raw.log'), 'a'.repeat(30));
			writeFileSync(join(runDir, 'events.ndjson'), 'b'.repeat(70));

			const res = await deleteByPath(runDir, { whitelistRoot, fs });

			expect(res).toEqual({ ok: true, path: runDir, bytesFreed: 100 });
			expect(fs.listDirectory(runDir)).toEqual([]);
			expect(fs.fileLenSync(runDir)).toBeNull();
		});

		it('returns E_LOG_FILE_MISSING when deleting a non-existent file', async () => {
			const res = await deleteByPath(join(whitelistRoot, 'run-ok', 'missing.log'), {
				whitelistRoot,
				fs,
			});
			expect(res).toMatchObject({ ok: false, code: 'E_LOG_FILE_MISSING', retryable: false });
		});

		it('truncates an existing file and reports bytesFreed', async () => {
			const runDir = join(whitelistRoot, 'run-trunc');
			fs.mkdirSync(runDir);
			const targetFile = join(runDir, 'raw.log');
			writeFileSync(targetFile, '0123456789ABCDEF');

			const res = await truncate(targetFile, 4, { whitelistRoot, fs });

			expect(res).toEqual({ ok: true, path: targetFile, bytesFreed: 12, newSize: 4 });
			expect(fs.fileLenSync(targetFile)).toBe(4);
		});

		it('truncate is a no-op for a file already at or below the target size', async () => {
			const runDir = join(whitelistRoot, 'run-small');
			fs.mkdirSync(runDir);
			const targetFile = join(runDir, 'raw.log');
			writeFileSync(targetFile, 'abc');

			const res = await truncate(targetFile, 10, { whitelistRoot, fs });

			expect(res).toEqual({ ok: true, path: targetFile, bytesFreed: 0, newSize: 3 });
		});
	});

	describe('E-103: calculateDiskUsage', () => {
		it('aggregates usage by run sorted descending by bytes', async () => {
			fs.mkdirSync(join(whitelistRoot, 'run-small'));
			writeFileSync(join(whitelistRoot, 'run-small', 'raw.log'), 'a'.repeat(50));
			fs.mkdirSync(join(whitelistRoot, 'run-big'));
			writeFileSync(join(whitelistRoot, 'run-big', 'events.ndjson'), 'b'.repeat(300));
			writeFileSync(join(whitelistRoot, 'run-big', 'raw.log'), 'c'.repeat(200));
			fs.mkdirSync(join(whitelistRoot, 'run-mid'));
			writeFileSync(join(whitelistRoot, 'run-mid', 'raw.log'), 'd'.repeat(100));

			const report = await calculateDiskUsage({ whitelistRoot, fs, warnThresholdBytes: 1000 });

			expect(report.dataDirBytes).toBe(650);
			expect(report.byRun.map((r) => [r.runId, r.bytes, r.fileCount])).toEqual([
				['run-big', 500, 2],
				['run-mid', 100, 1],
				['run-small', 50, 1],
			]);
			expect(report.isWarnThresholdExceeded).toBe(false);
			expect(report.freeBytes).toBeGreaterThan(0);
			expect(report.isDiskFull).toBe(false);
		});

		it('marks isWarnThresholdExceeded when the byte total reaches warnThreshold', async () => {
			fs.mkdirSync(join(whitelistRoot, 'run-exceed'));
			writeFileSync(join(whitelistRoot, 'run-exceed', 'raw.log'), 'x'.repeat(150));

			const report = await calculateDiskUsage({ whitelistRoot, fs, warnThresholdBytes: 100 });

			expect(report.dataDirBytes).toBe(150);
			expect(report.warnThreshold).toBe(100);
			expect(report.isWarnThresholdExceeded).toBe(true);
		});

		it('reads free space from statfs: below the free threshold warns, zero blocks means full', async () => {
			const tight: LogFileSystem = {
				...fs,
				statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 100 }),
			};
			const warned = await calculateDiskUsage({
				whitelistRoot,
				fs: tight,
				freeThresholdBytes: 100_000,
			});
			expect(warned.freeBytes).toBe(40_960);
			expect(warned.isWarnThresholdExceeded).toBe(true);
			expect(warned.isDiskFull).toBe(false);

			const full: LogFileSystem = {
				...fs,
				statfs: async () => ({ bavail: 0, bsize: 4096, blocks: 100 }),
			};
			const report = await calculateDiskUsage({ whitelistRoot, fs: full });
			expect(report.isDiskFull).toBe(true);
			expect(report.isWarnThresholdExceeded).toBe(true);
		});

		it('treats a run root that does not exist yet as empty', async () => {
			const report = await calculateDiskUsage({
				whitelistRoot: join(testDir, 'never-created'),
				fs,
			});
			expect(report.dataDirBytes).toBe(0);
			expect(report.byRun).toEqual([]);
			expect(report.isWarnThresholdExceeded).toBe(false);
		});
	});

	describe('createLogstorePrimitives bundle', () => {
		it('binds deleteByPath, truncate (default target 0) and usage to one whitelist root', async () => {
			const primitives = createLogstorePrimitives({ whitelistRoot, fs });
			const runDir = join(whitelistRoot, 'run-bundle');
			fs.mkdirSync(runDir);
			const targetFile = join(runDir, 'raw.log');
			writeFileSync(targetFile, 'bundle');

			expect(await primitives.truncate(targetFile)).toMatchObject({ ok: true, newSize: 0 });
			expect((await primitives.usage()).byRun).toEqual([
				{ runId: 'run-bundle', bytes: 0, fileCount: 1 },
			]);
			expect(await primitives.deleteByPath(join(testDir, 'outside.txt'))).toMatchObject({
				ok: false,
				code: 'E_FORBIDDEN',
			});
		});
	});
});
