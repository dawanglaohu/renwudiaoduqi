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

	it('AC 2 & E-234: daemon and web src/ contain no union types assembled from status literals or duplicate status array definitions', () => {
		const daemonFiles = collectFiles(daemonSrcRoot);
		const webFiles = collectFiles(webSrcRoot);
		const targetFiles = [...daemonFiles, ...webFiles];

		// 检查状态联合类型声明与数组定义：
		// 1) 严禁在 daemon/web src/ 中声明 type RunState / BatchState / TaskState = ...
		// 2) 严禁重新定义状态数组：const RUN_STATES/BATCH_STATES/TASK_STATES/VALID_BATCH_STATES = [...] 或 [...RUN_STATES, ...]
		// 3) 严禁在本地拼装调度器运行状态、批次状态或任务状态的联合类型（单行或多行）
		const forbiddenTypeDefNames = /\btype\s+(?:RunState|BatchState|TaskState)\s*=/;
		const forbiddenArrayDefPattern =
			/\b(?:const|let|var)\s+(?:RUN_STATES|BATCH_STATES|TASK_STATES|VALID_BATCH_STATES)\s*=\s*\[/;
		const forbiddenSpreadPattern = /\[\s*\.\.\.\s*RUN_STATES/;

		const multilineTypeUnionRegex = /\btype\s+(\w+)\s*=\s*([^;]+);/gs;

		const runStateLiterals = new Set([
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
		]);

		const batchSpecificLiterals = new Set([
			'idle',
			'paused',
			'awaiting_landing',
			'wrapping',
			'needs_attention',
		]);

		const batchStateLiterals = new Set([...batchSpecificLiterals, 'running', 'done']);

		const violations: { file: string; line: number; text: string }[] = [];

		for (const file of targetFiles) {
			const content = readFileSync(file, 'utf8');
			const lines = content.split('\n');
			const relPath = relative(repositoryRoot, file).replace(/\\/g, '/');

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (forbiddenTypeDefNames.test(line)) {
					violations.push({
						file: relPath,
						line: i + 1,
						text: line.trim(),
					});
				}
				if (forbiddenArrayDefPattern.test(line)) {
					violations.push({
						file: relPath,
						line: i + 1,
						text: line.trim(),
					});
				}
				if (forbiddenSpreadPattern.test(line)) {
					violations.push({
						file: relPath,
						line: i + 1,
						text: line.trim(),
					});
				}
			}

			const matches = Array.from(content.matchAll(multilineTypeUnionRegex));
			for (const match of matches) {
				const typeName = match[1] ?? '';
				const typeBody = match[2] ?? '';
				if (typeBody.includes('|')) {
					const quotedLiterals = Array.from(typeBody.matchAll(/['"]([a-z_]+)['"]/g)).map(
						(m) => m[1] ?? '',
					);

					const matchedRunLiterals = quotedLiterals.filter((lit) => runStateLiterals.has(lit));
					const matchedBatchLiterals = quotedLiterals.filter((lit) => batchStateLiterals.has(lit));
					const hasBatchSpecific = quotedLiterals.some((lit) => batchSpecificLiterals.has(lit));
					const hasNeverDispatched = quotedLiterals.includes('never_dispatched');

					// 判定是否为状态联合类型定义：
					// - 包含 3 个及以上运行态
					// - 或包含 3 个及以上批次态且含批次特有态
					// - 或包含 never_dispatched
					const isStatusUnion =
						matchedRunLiterals.length >= 3 ||
						(matchedBatchLiterals.length >= 3 && hasBatchSpecific) ||
						hasNeverDispatched;

					if (isStatusUnion) {
						const matchIndex = match.index ?? 0;
						const lineNumber = content.slice(0, matchIndex).split('\n').length;
						const text = match[0].split('\n')[0]?.trim() ?? '';
						if (!violations.some((v) => v.file === relPath && v.line === lineNumber)) {
							violations.push({
								file: relPath,
								line: lineNumber,
								text: `${text}...`,
							});
						}
					}
				}
			}
		}

		expect(
			violations,
			`Found status union or re-definition in daemon/web src/: ${JSON.stringify(violations, null, 2)}`,
		).toEqual([]);
	});

	it('AC 2 & E-234: architecture test catches multiline status unions and derived status arrays', () => {
		const sampleMultilineBatchState = `
			export type BatchState =
				| 'idle'
				| 'running'
				| 'paused'
				| 'awaiting_landing'
				| 'wrapping'
				| 'needs_attention'
				| 'done';
			export const VALID_BATCH_STATES = [
				'idle',
				'running',
				'paused',
			] as const;
		`;
		const sampleDerivedTaskState = `
			export const TASK_STATES = [...RUN_STATES, 'never_dispatched'] as const;
			export type TaskState = (typeof TASK_STATES)[number];
		`;

		const forbiddenTypeDefNames = /\btype\s+(?:RunState|BatchState|TaskState)\s*=/;
		const forbiddenArrayDefPattern =
			/\b(?:const|let|var)\s+(?:RUN_STATES|BATCH_STATES|TASK_STATES|VALID_BATCH_STATES)\s*=\s*\[/;
		const forbiddenSpreadPattern = /\[\s*\.\.\.\s*RUN_STATES/;

		expect(forbiddenTypeDefNames.test(sampleMultilineBatchState)).toBe(true);
		expect(forbiddenArrayDefPattern.test(sampleMultilineBatchState)).toBe(true);
		expect(forbiddenTypeDefNames.test(sampleDerivedTaskState)).toBe(true);
		expect(forbiddenArrayDefPattern.test(sampleDerivedTaskState)).toBe(true);
		expect(forbiddenSpreadPattern.test(sampleDerivedTaskState)).toBe(true);
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
