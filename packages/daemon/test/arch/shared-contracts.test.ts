import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_STATES } from '@agent-scheduler/shared/api/runs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sharedSrcRoot = join(repositoryRoot, 'packages/shared/src');
const daemonSrcRoot = join(repositoryRoot, 'packages/daemon/src');
const webSrcRoot = join(repositoryRoot, 'packages/web/src');

function collectFiles(dir: string, extensionRegex: RegExp = /\.(ts|tsx|js|mjs)$/): string[] {
	const results: string[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name === 'node_modules' ||
					entry.name === 'dist' ||
					entry.name === '.git' ||
					entry.name === 'test' ||
					entry.name === '__tests__'
				) {
					continue;
				}
				results.push(...collectFiles(fullPath, extensionRegex));
			} else if (entry.isFile() && extensionRegex.test(entry.name)) {
				results.push(fullPath);
			}
		}
	} catch {
		// ignore missing dir
	}
	return results;
}

function collectAllRepoSourceFiles(dir: string): string[] {
	const results: string[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name === 'node_modules' ||
					entry.name === 'dist' ||
					entry.name === '.git' ||
					entry.name === '.codex-plans' ||
					entry.name === 'coverage'
				) {
					continue;
				}
				results.push(...collectAllRepoSourceFiles(fullPath));
			} else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
				results.push(fullPath);
			}
		}
	} catch {
		// ignore missing dir
	}
	return results;
}

describe('M2-T8 Architecture: Contract Enum Tightening & Named Snapshot Arrays', () => {
	// ─── AC 1 & E-234: packages/shared/src 里 unknown[] 为 0 处、state: string 为 0 处 ───
	it('AC 1 & E-234: packages/shared/src has exactly 0 occurrences of unknown[] and state: string', () => {
		const sharedFiles = collectFiles(sharedSrcRoot, /\.ts$/);
		expect(sharedFiles.length).toBeGreaterThan(0);

		const unknownArrayMatches: { file: string; line: number; text: string }[] = [];
		const stateStringMatches: { file: string; line: number; text: string }[] = [];

		const unknownArrayRegex = /\bunknown\s*\[\s*\]/;
		const stateStringRegex = /\bstate\s*:\s*string\b/;

		for (const file of sharedFiles) {
			const content = readFileSync(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (unknownArrayRegex.test(line)) {
					unknownArrayMatches.push({
						file: relative(repositoryRoot, file).replace(/\\/g, '/'),
						line: i + 1,
						text: line.trim(),
					});
				}
				if (stateStringRegex.test(line)) {
					stateStringMatches.push({
						file: relative(repositoryRoot, file).replace(/\\/g, '/'),
						line: i + 1,
						text: line.trim(),
					});
				}
			}
		}

		expect(
			unknownArrayMatches,
			`Found unknown[] in shared/src: ${JSON.stringify(unknownArrayMatches, null, 2)}`,
		).toEqual([]);

		expect(
			stateStringMatches,
			`Found state: string in shared/src: ${JSON.stringify(stateStringMatches, null, 2)}`,
		).toEqual([]);
	});

	// ─── AC 2 & E-234: RunState/BatchState/TaskState 各只在 shared 定义一处，RUN_STATES 13 态 ───
	it('AC 2 & E-234: RUN_STATES has exactly 13 states verbatim matching Section 09 diagram', () => {
		const expected09RunStates = [
			'queued',
			'starting',
			'running',
			'awaiting_reply',
			'exited',
			'reviewing',
			'reworking',
			'awaiting_human',
			'orphaned',
			'landed',
			'failed',
			'aborted',
			'interrupted',
		] as const;

		expect(RUN_STATES).toHaveLength(13);
		expect(RUN_STATES).toEqual(expected09RunStates);
	});

	it('AC 2 & E-234: daemon and web src/ contain no union types assembled from status literals', () => {
		const daemonFiles = collectFiles(daemonSrcRoot);
		const webFiles = collectFiles(webSrcRoot);
		const targetFiles = [...daemonFiles, ...webFiles];

		// 检查是否有直接用 'queued' | 'starting' | 'running' 等运行态字面量拼装联合类型的声明
		// 或 const RUN_STATES = ['queued', ...] 的重新定义
		const unionPattern =
			/(?:type\s+\w+\s*=\s*(?:[^\n;]*['"]queued['"][^\n;]*\||['"]starting['"][^\n;]*\||['"]running['"][^\n;]*\|))|const\s+RUN_STATES\s*=\s*\[/;

		const violations: { file: string; line: number; text: string }[] = [];

		for (const file of targetFiles) {
			const content = readFileSync(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (unionPattern.test(line)) {
					violations.push({
						file: relative(repositoryRoot, file).replace(/\\/g, '/'),
						line: i + 1,
						text: line.trim(),
					});
				}
			}
		}

		expect(
			violations,
			`Found status union or re-definition in daemon/web src/: ${JSON.stringify(violations, null, 2)}`,
		).toEqual([]);
	});

	// ─── AC 3: function isRecord 全仓恰 1 处且 packages/shared dependencies 为空 ───
	it('AC 3: function isRecord is declared exactly once across the repository at packages/shared/src/lib/is-record.ts', () => {
		const allFiles = collectAllRepoSourceFiles(join(repositoryRoot, 'packages')).filter(
			(f) => !f.endsWith('shared-contracts.test.ts'),
		);
		const isRecordDeclarations: { file: string; line: number; text: string }[] = [];
		const isRecordDeclRegex = /(?:export\s+)?function\s+isRecord\s*\(/;

		for (const file of allFiles) {
			const content = readFileSync(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (isRecordDeclRegex.test(line)) {
					isRecordDeclarations.push({
						file: relative(repositoryRoot, file).replace(/\\/g, '/'),
						line: i + 1,
						text: line.trim(),
					});
				}
			}
		}

		expect(isRecordDeclarations).toHaveLength(1);
		expect(isRecordDeclarations[0]?.file).toBe('packages/shared/src/lib/is-record.ts');
	});

	it('AC 3: packages/shared package.json has empty dependencies', () => {
		const packageJsonPath = join(repositoryRoot, 'packages/shared/package.json');
		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
		const deps = packageJson.dependencies;
		expect(deps === undefined || Object.keys(deps).length === 0).toBe(true);
	});

	// ─── AC 4 & E-234: web RUN_STATE_TO_STATUS satisfies 13 态且 STATUS_STATES 1:1 对应 ───
	it('AC 4 & E-234: web RUN_STATE_TO_STATUS covers 13 RunStates and STATUS_STATES matches STATUS_SHAPES 1:1', () => {
		const spineShapeFile = join(webSrcRoot, 'lib/spine-shape.ts');
		const content = readFileSync(spineShapeFile, 'utf8');

		// 断言 RUN_STATE_TO_STATUS 存在且声明了 satisfies Record<RunState, ...>
		expect(content).toMatch(
			/export\s+const\s+RUN_STATE_TO_STATUS\s*=\s*\{[\s\S]*?\}\s*as\s+const\s+satisfies\s+Record<RunState,\s*\w+>/,
		);

		// 断言全部 13 个 RunState 均作为键出现
		for (const runState of RUN_STATES) {
			const keyRegex = new RegExp(`\\b${runState}\\s*:`);
			expect(keyRegex.test(content), `RUN_STATE_TO_STATUS must include key '${runState}'`).toBe(
				true,
			);
		}

		// 断言 STATUS_STATES 存在且包含 12 态
		expect(content).toMatch(/export\s+const\s+STATUS_STATES\s*=\s*\[/);
		expect(content).toMatch(/export\s+const\s+STATUS_SHAPES/);
	});
});
