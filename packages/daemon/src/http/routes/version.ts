import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_API_VERSION, type VersionResponse } from '@agent-scheduler/shared/api/system';
import type { FastifyInstance } from 'fastify';

function getDaemonPackageVersion(): string {
	try {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const pkgPath = resolve(currentDir, '../../../package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

const DAEMON_VERSION = getDaemonPackageVersion();

export function registerVersionRoute(instance: FastifyInstance): void {
	instance.get('/api/v1/version', async (): Promise<VersionResponse> => {
		return {
			daemon: DAEMON_VERSION,
			apiVersion: CURRENT_API_VERSION,
			node: process.version,
		};
	});
}
