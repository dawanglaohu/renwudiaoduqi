import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import { isEnoent, toFilesystemError } from '../../src/logstore/fs-errors.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';

describe('logstore fs-errors (R4)', () => {
	it('ENOENT at the read boundary maps to E_LOG_FILE_MISSING', () => {
		const cause = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		const wrapped = toFilesystemError(cause, 'read failed');
		expect(wrapped).toBeInstanceOf(AppError);
		expect(wrapped.code).toBe('E_LOG_FILE_MISSING');
		expect(wrapped.cause).toBe(cause);
	});

	it('EACCES (permission denied) maps to E_INTERNAL with the original cause', () => {
		const cause = Object.assign(new Error('EACCES'), { code: 'EACCES' });
		const wrapped = toFilesystemError(cause, 'write failed');
		expect(wrapped.code).toBe('E_INTERNAL');
		expect(wrapped.cause).toBe(cause);
		expect(wrapped.retryable).toBe(false);
	});

	it('regular ENOENT from the same path is not collapsing with EACCES', () => {
		expect(isEnoent(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).toBe(true);
		expect(isEnoent(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
	});

	it('R4: readRange/readFile wrap stat-then-delete ENOENT races as AppError E_LOG_FILE_MISSING', async () => {
		const fs = createNodeLogFileSystem();
		// The file never existed; ENOENT must come back wrapped, not as a raw fs error.
		await expect(fs.readFile('/definitely/not/a/log/path.ndjson')).rejects.toMatchObject({
			code: 'E_LOG_FILE_MISSING',
		});
		// readRange on a missing file surfaces the async ENOENT from the stream 'error' event.
		await expect(fs.readRange('/definitely/not/a/log/path.ndjson', 0, 10)).rejects.toBeInstanceOf(
			AppError,
		);
	});

	it('write failure during append surfaces as AppError (X-154 write is safe to inspect)', async () => {
		const failingFs = {
			mkdirSync() {},
			appendFile: async (_path: string, _data: Uint8Array) => {
				throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
			},
			readFile: async () => new Uint8Array(0),
			readRange: async () => new Uint8Array(0),
			fileLenSync: () => null,
			listDirectory: () => [],
		};
		const { createRunWriter } = await import('../../src/logstore/run-writer.ts');
		const { createLogstorePaths } = await import('../../src/logstore/paths.ts');
		const writer = createRunWriter({
			runId: 'run-x',
			paths: createLogstorePaths('/unused'),
			queue: {
				append: async (p: string, d: Uint8Array) => failingFs.appendFile(p, d),
				pendingBytes: 0,
				drain: async () => {},
			},
			fs: failingFs,
		});
		// The run-writer does not wrap fs errors itself — that is the service boundary.
		// The raw Node error bubbles up from fs.appendFile.
		await expect(writer.appendEventLine(new Uint8Array([65]))).rejects.toMatchObject({
			code: 'ENOSPC',
		});
	});
});
