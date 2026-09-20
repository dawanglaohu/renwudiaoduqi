import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
