import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogFileSystem } from '../../src/logstore/contract.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import {
	calculateDiskUsage,
	createLogstorePrimitives,
	deleteByPath,
	isPathWithinWhitelist,
	truncate,
} from '../../src/logstore/primitives.ts';

describe('logstore primitives (M1-T5)', () => {
	let testDir: string;
	let whitelistRoot: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'sched-disk-prim-'));
		whitelistRoot = join(testDir, 'runs');
		const fs = createNodeLogFileSystem();
		fs.mkdirSync(whitelistRoot);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	describe('E-206: whitelist directory restriction & violation logging', () => {
		it('allows files located inside the whitelist root', () => {
			const validPath = join(whitelistRoot, 'run-1', 'raw.log');
			expect(isPathWithinWhitelist(validPath, whitelistRoot)).toBe(true);
		});

		it('rejects the whitelist root itself to prevent wiping entire store', () => {
			expect(isPathWithinWhitelist(whitelistRoot, whitelistRoot)).toBe(false);
		});

		it('rejects path traversal attempts pointing outside the whitelist root', () => {
			const traversalPath = join(whitelistRoot, '..', 'app.db');
			expect(isPathWithinWhitelist(traversalPath, whitelistRoot)).toBe(false);

			const deepTraversal = join(whitelistRoot, 'run-1', '..', '..', 'secret.txt');
			expect(isPathWithinWhitelist(deepTraversal, whitelistRoot)).toBe(false);
		});

		it('rejects paths on another drive or root directory', () => {
			expect(isPathWithinWhitelist('/etc/passwd', whitelistRoot)).toBe(false);
			expect(isPathWithinWhitelist('C:\\Windows\\System32\\calc.exe', whitelistRoot)).toBe(false);
		});

		it('rejects protected database and system files even if inside whitelist root', () => {
			expect(isPathWithinWhitelist(join(whitelistRoot, 'app.db'), whitelistRoot)).toBe(false);
			expect(isPathWithinWhitelist(join(whitelistRoot, 'app.db-wal'), whitelistRoot)).toBe(false);
			expect(isPathWithinWhitelist(join(whitelistRoot, 'pairing-code.txt'), whitelistRoot)).toBe(
				false,
			);
			expect(isPathWithinWhitelist(join(whitelistRoot, 'instance.lock'), whitelistRoot)).toBe(
				false,
			);
		});

		it('deleteByPath refuses paths outside whitelist and writes security violation log', async () => {
			const violations: string[] = [];
			const logViolation = (msg: string) => violations.push(msg);

			const outsidePath = join(testDir, 'sensitive-outside.txt');
			writeFileSync(outsidePath, 'secret data');

			const res = await deleteByPath(outsidePath, {
				whitelistRoot,
				logViolation,
			});

			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.code).toBe('E_FORBIDDEN');
				expect(res.retryable).toBe(false);
			}

			// Violation was recorded
			expect(violations).toHaveLength(1);
			expect(violations[0]).toContain('[SECURITY_VIOLATION]');
			expect(violations[0]).toContain('sensitive-outside.txt');

			// File was NOT deleted
			const fs = createNodeLogFileSystem();
			expect(fs.fileLenSync(outsidePath)).toBeGreaterThan(0);
		});

		it('truncate refuses paths outside whitelist and writes security violation log', async () => {
			const violations: string[] = [];
			const logViolation = (msg: string) => violations.push(msg);

			const outsidePath = join(testDir, 'another-outside.txt');
			writeFileSync(outsidePath, 'some data to truncate');

			const res = await truncate(outsidePath, 0, {
				whitelistRoot,
				logViolation,
			});

			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.code).toBe('E_FORBIDDEN');
				expect(res.retryable).toBe(false);
			}

			expect(violations).toHaveLength(1);
			expect(violations[0]).toContain('[SECURITY_VIOLATION]');

			const fs = createNodeLogFileSystem();
			expect(fs.fileLenSync(outsidePath)).toBeGreaterThan(0);
		});
	});

	describe('E-204: target file being read (EBUSY) returns retryable error without throwing', () => {
		it('deleteByPath returns ok:false with retryable:true and EBUSY code when locked', async () => {
			const mockFs: LogFileSystem = {
				mkdirSync() {},
				listDirectory: () => [],
				appendFile: async () => {},
				readFile: async () => new Uint8Array(0),
				readRange: async () => new Uint8Array(0),
				fileLenSync: () => 1024,
				deleteFile: async () => {
					const error = new Error('resource busy or locked');
					Object.assign(error, { code: 'EBUSY' });
					throw error;
				},
			};

			const targetFile = join(whitelistRoot, 'run-busy', 'raw.log');
			const res = await deleteByPath(targetFile, {
				whitelistRoot,
				fs: mockFs,
			});

			// Must return typed result rather than throwing
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.code).toBe('EBUSY');
				expect(res.retryable).toBe(true);
				expect(res.path).toBe(targetFile);
			}
		});

		it('truncate returns ok:false with retryable:true and EBUSY code when locked', async () => {
			const mockFs: LogFileSystem = {
				mkdirSync() {},
				listDirectory: () => [],
				appendFile: async () => {},
				readFile: async () => new Uint8Array(0),
				readRange: async () => new Uint8Array(0),
				fileLenSync: () => 2048,
				truncateFile: async () => {
					const error = new Error('resource busy or locked');
					Object.assign(error, { code: 'EBUSY' });
					throw error;
				},
			};

			const targetFile = join(whitelistRoot, 'run-busy', 'events.ndjson');
			const res = await truncate(targetFile, 0, {
				whitelistRoot,
				fs: mockFs,
			});

			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.code).toBe('EBUSY');
				expect(res.retryable).toBe(true);
				expect(res.path).toBe(targetFile);
			}
		});
	});

	describe('successful deletion and truncation', () => {
		it('deletes an existing file inside whitelist and returns bytesFreed', async () => {
			const fs = createNodeLogFileSystem();
			const runDir = join(whitelistRoot, 'run-ok');
			fs.mkdirSync(runDir);
			const targetFile = join(runDir, 'raw.log');
			writeFileSync(targetFile, 'content 12345');

			const res = await deleteByPath(targetFile, {
				whitelistRoot,
				fs,
			});

			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.bytesFreed).toBe(13);
				expect(res.path).toBe(targetFile);
			}
			expect(fs.fileLenSync(targetFile)).toBeNull();
		});

		it('returns E_LOG_FILE_MISSING when deleting a non-existent file', async () => {
			const missingFile = join(whitelistRoot, 'run-ok', 'missing.log');
			const res = await deleteByPath(missingFile, {
				whitelistRoot,
			});

			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.code).toBe('E_LOG_FILE_MISSING');
				expect(res.retryable).toBe(false);
			}
		});

		it('truncates an existing file and reports bytesFreed', async () => {
			const fs = createNodeLogFileSystem();
			const runDir = join(whitelistRoot, 'run-trunc');
			fs.mkdirSync(runDir);
			const targetFile = join(runDir, 'raw.log');
			writeFileSync(targetFile, '0123456789ABCDEF'); // 16 bytes

			const res = await truncate(targetFile, 4, {
				whitelistRoot,
				fs,
			});

			expect(res.ok).toBe(true);
			if (res.ok) {
				expect(res.bytesFreed).toBe(12);
				expect(res.newSize).toBe(4);
			}
			expect(fs.fileLenSync(targetFile)).toBe(4);
		});
	});

	describe('E-103: calculateDiskUsage', () => {
		it('aggregates usage by run sorted descending by bytes', async () => {
			const fs = createNodeLogFileSystem();

			// Run 1: 50 bytes
			const run1Dir = join(whitelistRoot, 'run-small');
			fs.mkdirSync(run1Dir);
			writeFileSync(join(run1Dir, 'raw.log'), 'a'.repeat(50));

			// Run 2: 500 bytes
			const run2Dir = join(whitelistRoot, 'run-big');
			fs.mkdirSync(run2Dir);
			writeFileSync(join(run2Dir, 'events.ndjson'), 'b'.repeat(300));
			writeFileSync(join(run2Dir, 'raw.log'), 'c'.repeat(200));

			// Run 3: 100 bytes
			const run3Dir = join(whitelistRoot, 'run-mid');
			fs.mkdirSync(run3Dir);
			writeFileSync(join(run3Dir, 'raw.log'), 'd'.repeat(100));

			const report = await calculateDiskUsage({
				whitelistRoot,
				fs,
				warnThresholdBytes: 1000,
			});

			expect(report.dataDirBytes).toBe(650);
			expect(report.byRun).toHaveLength(3);
			// Sorted descending: run-big (500), run-mid (100), run-small (50)
			expect(report.byRun[0]?.runId).toBe('run-big');
			expect(report.byRun[0]?.bytes).toBe(500);
			expect(report.byRun[1]?.runId).toBe('run-mid');
			expect(report.byRun[1]?.bytes).toBe(100);
			expect(report.byRun[2]?.runId).toBe('run-small');
			expect(report.byRun[2]?.bytes).toBe(50);
			expect(report.isWarnThresholdExceeded).toBe(false);
		});

		it('marks isWarnThresholdExceeded when totalBytes exceeds warnThreshold', async () => {
			const fs = createNodeLogFileSystem();
			const runDir = join(whitelistRoot, 'run-exceed');
			fs.mkdirSync(runDir);
			writeFileSync(join(runDir, 'raw.log'), 'x'.repeat(150));

			const report = await calculateDiskUsage({
				whitelistRoot,
				fs,
				warnThresholdBytes: 100, // lower threshold
			});

			expect(report.dataDirBytes).toBe(150);
			expect(report.warnThreshold).toBe(100);
			expect(report.isWarnThresholdExceeded).toBe(true);
		});
	});

	describe('createLogstorePrimitives bundle', () => {
		it('packages deleteByPath, truncate, usage, and dispatchState together', async () => {
			const primitives = createLogstorePrimitives({
				whitelistRoot,
			});

			expect(typeof primitives.deleteByPath).toBe('function');
			expect(typeof primitives.truncate).toBe('function');
			expect(typeof primitives.usage).toBe('function');
			expect(primitives.dispatchState.isHalted()).toBe(false);

			primitives.dispatchState.setHalted(true, 'Test reason');
			expect(primitives.dispatchState.isHalted()).toBe(true);
			expect(primitives.dispatchState.getHaltedReason()).toBe('Test reason');
		});
	});
});
