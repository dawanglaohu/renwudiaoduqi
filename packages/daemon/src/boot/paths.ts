import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE_NAME = 'daemon.lock';

export interface DataDirectoryHost {
	readonly appDataDir: string | undefined;
	readonly homeDir: string;
}

export function defaultDataDir(host: DataDirectoryHost): string {
	if (host.appDataDir !== undefined && host.appDataDir.length > 0) {
		return join(host.appDataDir, 'agent-scheduler');
	}
	return join(host.homeDir, '.agent-scheduler');
}

export function resolveLockFilePath(host: DataDirectoryHost): string {
	const dir = defaultDataDir(host);
	mkdirSync(dir, { recursive: true });
	return join(dir, LOCK_FILE_NAME);
}
