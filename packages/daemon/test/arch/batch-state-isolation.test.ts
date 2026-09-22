import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonSrc = join(repositoryRoot, 'packages/daemon/src');

describe('M8-T6 Architecture: Batch State Isolation (R1, AC 1)', () => {
	it('forbids batches state mutations outside BatchService', () => {
		const files = listTypeScriptFiles(daemonSrc);
		expect(files.length).toBeGreaterThan(0);

		// Matches any direct call to updateState on a batches repo identifier
		const pattern = /\b(?:batchesRepo|batches)\.updateState\b/;
		const violations: string[] = [];

		for (const file of files) {
			const relativePath = relative(repositoryRoot, file).replaceAll('\\', '/');

			// Only repo/batches.ts (definition) and service/batch.ts (single state machine primitive) are permitted
			if (
				relativePath === 'packages/daemon/src/repo/batches.ts' ||
				relativePath === 'packages/daemon/src/service/batch.ts'
			) {
				continue;
			}

			const content = readFileSync(file, 'utf8');
			if (pattern.test(content)) {
				violations.push(relativePath);
			}
		}

		expect(violations).toEqual([]);
	});
});

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...listTypeScriptFiles(path));
		} else if (extname(entry.name) === '.ts') {
			files.push(path);
		}
	}
	return files;
}
