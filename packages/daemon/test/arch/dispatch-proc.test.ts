import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const dispatchServicePath = resolve(currentDir, '../../src/service/dispatch.ts');

describe('M8-T10 Architecture: dispatch proc boundary (AC 5, 08-backend)', () => {
	it('asserts service/dispatch.ts does not import child_process (08 proc is sole exit)', () => {
		const source = readFileSync(dispatchServicePath, 'utf8');

		// Check for any child_process imports
		const hasChildProcess = /from\s+['"](?:node:)?child_process['"]/.test(source);
		expect(hasChildProcess).toBe(false);

		// Check for any dynamic import or require of child_process
		const hasDynamicImport = /import\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source);
		expect(hasDynamicImport).toBe(false);

		const hasRequire = /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source);
		expect(hasRequire).toBe(false);
	});
});

describe('R8-T97041355 Architecture: no stderrTail/stdout heuristic guessing for model invalidity (AC 4, E-348)', () => {
	function collectTsFiles(dir: string): string[] {
		const files: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...collectTsFiles(full));
			} else if (
				['.ts', '.tsx'].includes(extname(entry.name)) &&
				!entry.name.endsWith('.test.ts')
			) {
				files.push(full);
			}
		}
		return files;
	}

	it('asserts packages/daemon/src/service and jobs contain no branches regex-matching or includes-checking stderrTail/stdout for model/invalid/not found', () => {
		const daemonSrc = resolve(currentDir, '../../src');
		const targetDirs = [join(daemonSrc, 'service'), join(daemonSrc, 'jobs')];
		const prohibitedPatterns = [
			/stderr(?:Tail)?\S*\.(?:includes|match|test)\([^)]*(?:model|invalid|not\s*found)/i,
			/(?:model|invalid|not\s*found)[^)]*\.(?:test|match)\([^)]*stderr/i,
			/stdout\S*\.(?:includes|match|test)\([^)]*(?:model|invalid|not\s*found)/i,
			/(?:model|invalid|not\s*found)[^)]*\.(?:test|match)\([^)]*stdout/i,
		];

		const violations: Array<{ file: string; line: number; match: string }> = [];

		for (const dir of targetDirs) {
			const files = collectTsFiles(dir);
			for (const file of files) {
				const content = readFileSync(file, 'utf8');
				const lines = content.split('\n');
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (!line) continue;
					const trimmed = line.trim();
					if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
						continue;
					}
					for (const pattern of prohibitedPatterns) {
						if (pattern.test(line)) {
							violations.push({ file, line: i + 1, match: line.trim() });
						}
					}
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
