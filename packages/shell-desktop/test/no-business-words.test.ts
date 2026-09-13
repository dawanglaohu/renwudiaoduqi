import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getFilesRecursively(dir: string): string[] {
	const results: string[] = [];
	const entries = readdirSync(dir);
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			results.push(...getFilesRecursively(fullPath));
		} else if (/\.(ts|tsx|js|rs)$/.test(entry)) {
			results.push(fullPath);
		}
	}
	return results;
}

describe('architecture restriction: no business domain words in desktop shell (AC 1, E-257)', () => {
	it('asserts that task, run, gate, batch, agent do not appear in desktop shell source code', () => {
		const srcDir = join(__dirname, '../src');
		const files = getFilesRecursively(srcDir);

		const FORBIDDEN_PATTERN = /\b(task|run|gate|batch|agent)\b/i;
		const violations: Array<{ file: string; line: number; text: string }> = [];

		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const lineText = lines[i] ?? '';
				if (FORBIDDEN_PATTERN.test(lineText)) {
					violations.push({
						file,
						line: i + 1,
						text: lineText.trim(),
					});
				}
			}
		}

		if (violations.length > 0) {
			const summary = violations.map((v) => `${v.file}:${v.line} -> "${v.text}"`).join('\n');
			expect.fail(
				`AC 1 violation: business domain words (task/run/gate/batch/agent) found in desktop shell source:\n${summary}`,
			);
		}

		expect(violations).toHaveLength(0);
	});
});
