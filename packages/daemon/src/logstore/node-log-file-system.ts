import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import type { LogFileSystem } from './contract.ts';
import { isEnoent, toFilesystemError, toLogFileMissing } from './fs-errors.ts';

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
				if (isEnoent(cause)) return [];
				throw toFilesystemError(cause, 'Failed to list log directory.');
			}
		},
		createReadStream(path: string, options: { readonly start: number; readonly end: number }) {
			try {
				return createReadStream(path, options);
			} catch (cause) {
				if (isEnoent(cause)) throw toLogFileMissing(cause, path);
				throw toFilesystemError(cause, 'Failed to open log file.');
			}
		},
		fileLenSync(path: string): number | null {
			try {
				return statSync(path).size;
			} catch (cause) {
				if (isEnoent(cause)) return null;
				throw toFilesystemError(cause, 'Failed to stat log file.');
			}
		},
		async appendFile(path: string, data: Uint8Array): Promise<void> {
			try {
				await appendFile(path, data);
			} catch (cause) {
				if (isEnoent(cause)) throw toLogFileMissing(cause, path);
				throw toFilesystemError(cause, 'Failed to append log file.');
			}
		},
	});
}
