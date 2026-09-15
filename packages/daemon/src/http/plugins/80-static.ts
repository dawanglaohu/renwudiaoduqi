import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/**
 * Resolves the web distribution directory using two fixed layouts (R2, AC 2):
 * 1. Source repo layout: packages/daemon/src/http/plugins -> packages/web/dist
 * 2. Packaged bundle layout: relative to daemon distribution root -> web/dist
 *
 * Prohibited from falling back to relative process.cwd().
 * Throws on startup if dist directory does not exist.
 */
export function resolveWebDistPath(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));

	// Rule 1: Source repository layout
	const sourceLayout = resolve(currentDir, '../../../../web/dist');
	if (existsSync(sourceLayout)) {
		return sourceLayout;
	}

	// Rule 2: Packaged bundle layout
	const packagedLayout = resolve(currentDir, '../../web/dist');
	if (existsSync(packagedLayout)) {
		return packagedLayout;
	}

	// Additional check when running from compiled daemon dist/
	const builtSourceLayout = resolve(currentDir, '../../../../../packages/web/dist');
	if (existsSync(builtSourceLayout)) {
		return builtSourceLayout;
	}

	throw new Error(
		`Web distribution directory not found. Expected '${sourceLayout}' or '${packagedLayout}' to exist. Please run 'vite build' before starting daemon.`,
	);
}

export const staticPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	const distRoot = resolveWebDistPath();

	await instance.register(fastifyStatic, {
		root: distRoot,
		prefix: '/',
		wildcard: true,
		index: ['index.html'],
	});
};
