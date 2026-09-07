import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { AppError } from '../errors/app-error.ts';
import type { LogFileSystem } from './contract.ts';

export interface NodeLogFileSystem extends LogFileSystem {
	readonly appendFileAsync: (path: string, data: Uint8Array) => Promise<void>;
}

export function createNodeLogFileSystem(): NodeLogFileSystem {
	return Object.freeze({
		mkdirSync(dir: string): void {
			mkdirSync(dir, { recursive: true });
		},
		listDirectory(path: string): readonly string[] {
			try {
				return readdirSync(path);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
					return [];
				}
				throw new AppError('E_INTERNAL', 'Failed to list log directory.', { cause });
			}
		},
		createReadStream(path: string, options: { readonly start: number; readonly end: number }) {
			return createReadStream(path, options);
		},
		fileLenSync(path: string): number | null {
			try {
				return statSync(path).size;
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
					return null;
				}
				throw new AppError('E_INTERNAL', 'Failed to stat log file.', { cause });
			}
		},
		async appendFileAsync(path: string, data: Uint8Array): Promise<void> {
			await appendFile(path, data);
		},
	});
}
