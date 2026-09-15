import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const serviceRoot = join(daemonRoot, 'src/service');

describe('M8-T3 service layer SQL isolation', () => {
	it('forbids SQL keywords and db.prepare in service/', () => {
		const files = listTypeScriptFiles(serviceRoot);
		expect(files.length).toBeGreaterThan(0);
		const sqlPattern = /\b(?:INSERT|SELECT|UPDATE|DELETE)\b|\bdb\.prepare\b/;
		const violations: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			if (sqlPattern.test(content)) {
				violations.push(relative(repositoryRoot, file).replaceAll('\\', '/'));
			}
		}
		expect(violations).toEqual([]);
	});
});

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
		else if (extname(entry.name) === '.ts') files.push(path);
	}
	return files;
}
