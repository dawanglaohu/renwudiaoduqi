import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PlatformHostInputs } from '../platform/contract.ts';
import { appDataDir } from '../platform/host.ts';

export interface DataDirFailure {
	readonly ok: false;
	readonly message: string;
	readonly path: string;
	readonly cause?: unknown;
}

export type DataDirResult = { readonly ok: true; readonly path: string } | DataDirFailure;

export function defaultDataDir(host: PlatformHostInputs): string {
	const resolved = appDataDir(host);
	if (!resolved.ok) {
		return `${host.homedir}/agent-scheduler`;
	}
	return resolved.path;
}

export function ensureDataDir(path: string): DataDirResult {
	if (path.length === 0) {
		return { ok: false, path, message: 'data directory path must not be empty' };
	}
	if (!isAbsolute(path)) {
		return { ok: false, path, message: 'data directory must be an absolute path' };
	}
	try {
		mkdirSync(path, { recursive: true });
		return { ok: true, path };
	} catch (cause) {
		return { ok: false, path, cause, message: 'directory creation failed' };
	}
}
