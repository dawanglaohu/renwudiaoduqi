import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const sourceRoot = join(daemonRoot, 'src');

describe('M1-T10 boot architecture', () => {
	it('keeps direct environment access at the two declared boundaries', () => {
		const approvedPaths = ['packages/daemon/src/config/env.ts', 'packages/daemon/src/proc/env.ts'];
		const matches = sourceFiles()
			.filter((file) => readFileSync(file, 'utf8').includes('process.env'))
			.map(repositoryPath);
		expect(matches).toContain('packages/daemon/src/config/env.ts');
		expect(matches.filter((path) => !approvedPaths.includes(path))).toEqual([]);
	});

	it('keeps child-process imports in proc and process exit or signal wiring in main', () => {
		const childProcessImports = sourceFiles()
			.filter((file) => /from ['"]node:child_process['"]/.test(readFileSync(file, 'utf8')))
			.map(repositoryPath);
		expect(childProcessImports.every((path) => path.includes('/src/proc/'))).toBe(true);

		const processControl = sourceFiles()
			.filter((file) => /process\.(?:exit|once\(['"]SIG)/.test(readFileSync(file, 'utf8')))
			.map(repositoryPath);
		expect(processControl).toEqual(['packages/daemon/src/main.ts']);
	});

	it('preserves the required startup order in the real startDaemon path', () => {
		const source = readFileSync(join(sourceRoot, 'main.ts'), 'utf8');
		const orderedCalls = [
			'loadProcessConfig({',
			'acquireInstanceLock(metadata',
			'ensureDataDirectory(config.dataDir)',
			'openDatabase(join(config.dataDir',
			'runMigrations(database)',
			'createContainer({',
			'createServer({ container })',
			'await server.listen({',
			'`daemon ready pid=',
		];
		let previous = -1;
		for (const call of orderedCalls) {
			const current = source.indexOf(call);
			expect(current, `${call} must exist after the previous startup stage`).toBeGreaterThan(
				previous,
			);
			previous = current;
		}
	});

	it('has the required integration and architecture test tiers', () => {
		expect(statSync(join(daemonRoot, 'test/integration')).isDirectory()).toBe(true);
		expect(statSync(join(daemonRoot, 'test/arch')).isDirectory()).toBe(true);
	});
});

function sourceFiles(): string[] {
	return listTypeScriptFiles(sourceRoot).sort();
}

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
		else if (extname(entry.name) === '.ts') files.push(path);
	}
	return files;
}

function repositoryPath(path: string): string {
	return relative(repositoryRoot, path).replaceAll('\\', '/');
}
