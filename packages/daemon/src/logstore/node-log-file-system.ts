import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { appendFile, readFile, rm, statfs, truncate } from 'node:fs/promises';
import type { LogFileSystem } from './contract.ts';
import {
	getNodeErrorCode,
	isEbusy,
	isEnoent,
	isEnospc,
	toDiskFullError,
	toFilesystemError,
	toLogFileMissing,
} from './fs-errors.ts';

/**
 * Real fs adapter for the logstore layer. Every native error is wrapped into an
 * AppError at this module boundary (R4): ENOENT → E_LOG_FILE_MISSING, everything
 * else → E_INTERNAL carrying the raw `cause`.
 */
export function createNodeLogFileSystem(): LogFileSystem {
	return Object.freeze({
		mkdirSync(dir: string): void {
			try {
				mkdirSync(dir, { recursive: true });
			} catch (cause) {
				throw toFilesystemError(cause, 'Failed to create log directory.');
			}
		},
		listDirectory(path: string): readonly string[] {
			try {
				return readdirSync(path);
			} catch (cause) {
				if (isEnoent(cause) || getNodeErrorCode(cause) === 'ENOTDIR') return [];
				throw toFilesystemError(cause, 'Failed to list log directory.');
			}
		},
		readFile(path: string): Promise<Uint8Array> {
			return readFile(path).catch((cause) => {
				throw toFilesystemError(cause, 'Failed to read log file.');
			});
		},
		async readRange(path: string, start: number, endInclusive: number): Promise<Uint8Array> {
			const chunks: Uint8Array[] = [];
			let total = 0;
			const stream = createReadStream(path, {
				start,
				end: endInclusive,
				autoClose: true,
			});
			try {
				for await (const chunk of stream) {
					const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
					total += buf.byteLength;
					chunks.push(buf);
				}
			} catch (cause) {
				if (isEnoent(cause)) throw toLogFileMissing(cause, path);
				throw toFilesystemError(cause, 'Failed to read log file range.');
			}
			return Buffer.concat(chunks, total);
		},
		fileLenSync(path: string): number | null {
			try {
				return statSync(path).size;
			} catch (cause) {
				// E-151: a deleted log file is a typed "missing" result, not an exception.
				if (isEnoent(cause)) return null;
				throw toFilesystemError(cause, 'Failed to stat log file.');
			}
		},
		async appendFile(path: string, data: Uint8Array): Promise<void> {
			try {
				await appendFile(path, data);
			} catch (cause) {
				if (isEnoent(cause)) throw toLogFileMissing(cause, path);
				if (isEnospc(cause)) throw toDiskFullError(cause, path);
				throw toFilesystemError(cause, 'Failed to append log file.');
			}
		},
		async deleteFile(path: string): Promise<void> {
			try {
				await rm(path, { recursive: true, force: false });
			} catch (cause) {
				if (isEbusy(cause)) {
					// E-204: rethrow raw cause with EBUSY/EPERM so primitives can catch as retryable
					throw cause;
				}
				if (isEnoent(cause)) throw toLogFileMissing(cause, path);
				throw toFilesystemError(cause, 'Failed to delete file.');
			}
		},
		async truncateFile(path: string, targetBytes = 0): Promise<void> {
			try {
				await truncate(path, targetBytes);
			} catch (cause) {
				if (isEbusy(cause)) {
					throw cause;
				}
				if (isEnoent(cause)) throw toLogFileMissing(cause, path);
				throw toFilesystemError(cause, 'Failed to truncate file.');
			}
		},
		async statfs(path: string): Promise<{ bavail: number; bsize: number; blocks: number }> {
			try {
				const res = await statfs(path);
				return {
					bavail: Number(res.bavail),
					bsize: Number(res.bsize),
					blocks: Number(res.blocks),
				};
			} catch (cause) {
				throw toFilesystemError(cause, 'Failed to query filesystem stats.');
			}
		},
	});
}
