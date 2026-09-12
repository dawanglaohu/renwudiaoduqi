import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
	type TaskPathDescriptor,
	buildPathConflictReason,
	buildWrapupFixSerialReason,
	checkTaskPathClash,
	doPathSetsClash,
	evaluatePathClashQueue,
	findPathClashes,
	getPathSegments,
	isPathClash,
	isPathConflictReason,
	isTaskLanded,
	isTaskPathHolding,
	isWrapupFixSerialReason,
	normalizePath,
	parsePathConflictReason,
	parseTaskPaths,
	parseWrapupFixSerialReason,
} from '../../src/domain/path-clash.ts';
import { AppError } from '../../src/errors/app-error.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const pathClashSourcePath = resolve(currentDir, '../../src/domain/path-clash.ts');

describe('M8-T2 domain/path-clash: 路径冲突检测与排队', () => {
	describe('Acceptance Criterion 3: 路径比较按段进行，model/order 不匹配 model/orderitem', () => {
		it('ensures normalizePath handles separators, duplicates, relative dots, and trims', () => {
			expect(normalizePath('model/order')).toBe('model/order');
			expect(normalizePath('model\\order')).toBe('model/order');
			expect(normalizePath('model//order///')).toBe('model/order');
			expect(normalizePath('./model/order/')).toBe('model/order');
			expect(normalizePath('/model/order')).toBe('model/order');
			expect(normalizePath('packages/daemon/src/../test')).toBe('packages/daemon/test');
			expect(normalizePath('   ')).toBe('');
			expect(normalizePath('')).toBe('');
		});

		it('ensures getPathSegments splits normalized paths into segment tokens', () => {
			expect(getPathSegments('model/order')).toEqual(['model', 'order']);
			expect(getPathSegments('model/orderitem')).toEqual(['model', 'orderitem']);
			expect(getPathSegments('model\\order\\item.ts')).toEqual(['model', 'order', 'item.ts']);
			expect(getPathSegments('')).toEqual([]);
			expect(getPathSegments('   ')).toEqual([]);
		});

		it('AC 3 core: model/order does NOT match model/orderitem', () => {
			const clashes = isPathClash('model/order', 'model/orderitem');
			expect(clashes).toBe(false);
		});

		it('matches identical paths (file or directory)', () => {
			expect(isPathClash('model/order', 'model/order')).toBe(true);
			expect(isPathClash('model/order/', 'model/order')).toBe(true);
			expect(isPathClash('model\\order', 'model/order')).toBe(true);
			expect(isPathClash('packages/daemon/src/a.ts', 'packages/daemon/src/a.ts')).toBe(true);
		});

		it('matches when one path is an ancestor directory containing the other', () => {
			// Directory containing file
			expect(isPathClash('model/order', 'model/order/item.ts')).toBe(true);
			expect(isPathClash('model/order/item.ts', 'model/order')).toBe(true);
			// Deep sub-directory
			expect(isPathClash('packages/daemon', 'packages/daemon/src/domain/path-clash.ts')).toBe(true);
			expect(isPathClash('packages/daemon/src/domain/path-clash.ts', 'packages/daemon')).toBe(true);
		});

		it('does NOT match sibling files or subpaths with matching prefix substrings', () => {
			expect(isPathClash('model/order.ts', 'model/order.test.ts')).toBe(false);
			expect(isPathClash('src/auth', 'src/author')).toBe(false);
			expect(isPathClash('src/auth.ts', 'src/authenticate.ts')).toBe(false);
			expect(isPathClash('packages/daemon/src/a.ts', 'packages/daemon/src/b.ts')).toBe(false);
			expect(isPathClash('domain/task', 'domain/task-state')).toBe(false);
		});

		it('returns false when either path is empty or blank', () => {
			expect(isPathClash('', 'model/order')).toBe(false);
			expect(isPathClash('model/order', '')).toBe(false);
			expect(isPathClash('', '')).toBe(false);
		});

		it('supports case-insensitive comparison when specified', () => {
			expect(isPathClash('Model/Order', 'model/order')).toBe(false);
			expect(isPathClash('Model/Order', 'model/order', { caseInsensitive: true })).toBe(true);
		});

		it('evaluates doPathSetsClash and findPathClashes correctly across sets', () => {
			const setA = ['packages/daemon/src/a.ts', 'packages/shared/src/api/tasks.ts'];
			const setB = ['packages/daemon/src/b.ts', 'packages/shared/src/api/tasks.ts'];
			const setC = ['packages/daemon/src/c.ts', 'packages/daemon/src/d.ts'];

			expect(doPathSetsClash(setA, setB)).toBe(true);
			expect(doPathSetsClash(setA, setC)).toBe(false);

			const clashes = findPathClashes(setA, setB);
			expect(clashes).toHaveLength(1);
			expect(clashes[0]?.pathA).toBe('packages/shared/src/api/tasks.ts');
			expect(clashes[0]?.pathB).toBe('packages/shared/src/api/tasks.ts');
		});

		it('parses taskPaths from JSON array, string array, and raw strings', () => {
			expect(parseTaskPaths('["packages/daemon/src/a.ts"]')).toEqual(['packages/daemon/src/a.ts']);
			expect(parseTaskPaths(['packages/daemon\\src/b.ts'])).toEqual(['packages/daemon/src/b.ts']);
			expect(parseTaskPaths(null)).toEqual([]);
			expect(parseTaskPaths(undefined)).toEqual([]);
			expect(parseTaskPaths('[]')).toEqual([]);
			expect(parseTaskPaths('packages/daemon/src/c.ts, packages/daemon/src/d.ts')).toEqual([
				'packages/daemon/src/c.ts',
				'packages/daemon/src/d.ts',
			]);
		});
	});

	describe('Acceptance Criterion 2: worktree 隔离不作为放行理由，代码中不存在「有 worktree 就放行」的分支', () => {
		it('asserts checkTaskPathClash reports conflict even when both tasks have distinct worktrees', () => {
			const taskA: TaskPathDescriptor = {
				taskId: 'task-101',
				taskKey: 'M8-T1',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				worktreePath: '/mnt/d/xiangmu/agent-scheduler-m8-t1',
				batchId: 'batch-1',
			};
			const taskB: TaskPathDescriptor = {
				taskId: 'task-102',
				taskKey: 'M8-T2',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				worktreePath: '/mnt/d/xiangmu/agent-scheduler-m8-t2',
				batchId: 'batch-1',
			};

			const result = checkTaskPathClash(taskA, taskB);
			expect(result.hasClash).toBe(true);
			expect(result.blockerTaskId).toBe('task-101');
			expect(result.blockerTaskKey).toBe('M8-T1');
		});

		it('asserts evaluatePathClashQueue blocks candidate despite worktree presence', () => {
			const activeTask: TaskPathDescriptor = {
				taskId: 'task-running-wt',
				taskKey: 'M4-T1',
				taskPaths: ['packages/daemon/src/adapters/codex/build-launch-spec.ts'],
				state: 'running',
				worktreePath: '/path/to/worktree-a',
				batchId: 'batch-4',
			};
			const candidate: TaskPathDescriptor = {
				taskId: 'task-candidate-wt',
				taskKey: 'M4-T2',
				taskPaths: ['packages/daemon/src/adapters/codex/build-launch-spec.ts'],
				state: 'queued',
				worktreePath: '/path/to/worktree-b',
				batchId: 'batch-4',
			};

			const evalResult = evaluatePathClashQueue({
				activeTasks: [activeTask],
				candidates: [candidate],
				batchId: 'batch-4',
			});

			expect(evalResult.dispatchable).toHaveLength(0);
			expect(evalResult.blocked).toHaveLength(1);
			expect(evalResult.blocked[0]?.blockedByTaskId).toBe('task-running-wt');
			expect(evalResult.pathConflictLimit).toBe(0);
		});

		it('AST check: verifies no branch in path-clash.ts checks worktreePath or worktree to grant clearance', () => {
			const sourceCode = readFileSync(pathClashSourcePath, 'utf8');
			const sourceFile = ts.createSourceFile(
				'path-clash.ts',
				sourceCode,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);

			let worktreeGrantClearanceViolations = 0;

			function inspectNode(node: ts.Node) {
				// Search for any if-statement or ternary checking worktree
				if (ts.isIfStatement(node)) {
					const conditionText = node.expression.getText(sourceFile);
					if (conditionText.includes('worktree')) {
						worktreeGrantClearanceViolations++;
					}
				}
				if (ts.isConditionalExpression(node)) {
					const conditionText = node.condition.getText(sourceFile);
					if (conditionText.includes('worktree')) {
						worktreeGrantClearanceViolations++;
					}
				}
				ts.forEachChild(node, inspectNode);
			}

			inspectNode(sourceFile);
			expect(
				worktreeGrantClearanceViolations,
				'Code must not contain any branching logic on worktree',
			).toBe(0);
		});
	});

	describe('Acceptance Criterion 1 & E-46: 同批内两任务 taskPaths 有交集时后者排队，等前者到达「已落地」（不是「已退出」）才起', () => {
		it('verifies isTaskLanded strictly checks for landed state', () => {
			expect(isTaskLanded('landed')).toBe(true);
			expect(isTaskLanded('exited')).toBe(false);
			expect(isTaskLanded('running')).toBe(false);
			expect(isTaskLanded('reviewing')).toBe(false);
			expect(isTaskLanded('awaiting_human')).toBe(false);
			expect(isTaskLanded('queued')).toBe(false);
			expect(isTaskLanded(undefined)).toBe(false);
			expect(isTaskLanded(null)).toBe(false);
		});

		it('verifies exited IS a path-holding state (process exited but NOT landed)', () => {
			expect(isTaskPathHolding('exited')).toBe(true);
			expect(isTaskPathHolding('running')).toBe(true);
			expect(isTaskPathHolding('starting')).toBe(true);
			expect(isTaskPathHolding('reviewing')).toBe(true);
			expect(isTaskPathHolding('reworking')).toBe(true);
			expect(isTaskPathHolding('awaiting_human')).toBe(true);
			expect(isTaskPathHolding('awaiting_reply')).toBe(true);
			expect(isTaskPathHolding('queued')).toBe(true);
			expect(isTaskPathHolding('orphaned')).toBe(true);

			// Terminal / landed states do NOT hold path lock
			expect(isTaskPathHolding('landed')).toBe(false);
			expect(isTaskPathHolding('failed')).toBe(false);
			expect(isTaskPathHolding('aborted')).toBe(false);
			expect(isTaskPathHolding('interrupted')).toBe(false);
		});

		it('E-46: an active task with missing or unrecognised state still holds the lock (never fails open)', () => {
			expect(isTaskPathHolding(undefined)).toBe(true);
			expect(isTaskPathHolding(null)).toBe(true);
			expect(isTaskPathHolding('')).toBe(true);
			expect(isTaskPathHolding('unrecognised_state')).toBe(true);

			const activeTask: TaskPathDescriptor = {
				taskId: 'task-prior',
				taskPaths: ['packages/daemon/src/domain/path-clash.ts'],
				batchId: 'batch-1',
			};
			const latterTask: TaskPathDescriptor = {
				taskId: 'task-latter',
				taskPaths: ['packages/daemon/src/domain/path-clash.ts'],
				batchId: 'batch-1',
			};

			const evaluation = evaluatePathClashQueue({
				activeTasks: [activeTask],
				candidates: [latterTask],
				batchId: 'batch-1',
			});

			expect(evaluation.dispatchable).toHaveLength(0);
			expect(evaluation.blocked).toHaveLength(1);
			expect(evaluation.blocked[0]?.blockedByTaskId).toBe('task-prior');
		});

		it('E-46: candidate task queues when earlier task is in exited state (NOT landed)', () => {
			const earlierTask: TaskPathDescriptor = {
				taskId: 'task-prior',
				taskKey: 'M8-T1',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				state: 'exited', // Agent exited, but review has NOT finished and code NOT landed!
				runId: 'run-001',
				batchId: 'batch-1',
			};
			const latterTask: TaskPathDescriptor = {
				taskId: 'task-latter',
				taskKey: 'M8-T2',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				state: 'queued',
				batchId: 'batch-1',
			};

			const evaluation = evaluatePathClashQueue({
				activeTasks: [earlierTask],
				candidates: [latterTask],
				batchId: 'batch-1',
			});

			// Latter task MUST queue because earlier task is only exited, NOT landed!
			expect(evaluation.dispatchable).toHaveLength(0);
			expect(evaluation.blocked).toHaveLength(1);
			expect(evaluation.blocked[0]?.task.taskId).toBe('task-latter');
			expect(evaluation.blocked[0]?.blockedByTaskId).toBe('task-prior');
			expect(evaluation.blocked[0]?.blockedByTaskKey).toBe('M8-T1');
			expect(evaluation.blocked[0]?.blockedByRunId).toBe('run-001');
			expect(evaluation.blocked[0]?.queuedReason).toBe('path_conflict:M8-T1:task-prior:run-001');
			expect(evaluation.pathConflictLimit).toBe(0);
		});

		it('E-46: candidate task queues through reviewing and awaiting_human states', () => {
			for (const activeState of ['reviewing', 'awaiting_human', 'reworking'] as const) {
				const activeTask: TaskPathDescriptor = {
					taskId: 'task-prior',
					taskKey: 'M8-T1',
					taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
					state: activeState,
					batchId: 'batch-1',
				};
				const latterTask: TaskPathDescriptor = {
					taskId: 'task-latter',
					taskKey: 'M8-T2',
					taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
					state: 'queued',
					batchId: 'batch-1',
				};

				const evalResult = evaluatePathClashQueue({
					activeTasks: [activeTask],
					candidates: [latterTask],
					batchId: 'batch-1',
				});

				expect(evalResult.dispatchable).toHaveLength(0);
				expect(evalResult.blocked).toHaveLength(1);
				expect(evalResult.blocked[0]?.blockedByTaskId).toBe('task-prior');
			}
		});

		it('E-46: candidate task is unblocked and released when earlier task reaches landed', () => {
			const earlierTask: TaskPathDescriptor = {
				taskId: 'task-prior',
				taskKey: 'M8-T1',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				state: 'landed', // Reached landed!
				batchId: 'batch-1',
			};
			const latterTask: TaskPathDescriptor = {
				taskId: 'task-latter',
				taskKey: 'M8-T2',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				state: 'queued',
				batchId: 'batch-1',
			};

			const evaluation = evaluatePathClashQueue({
				activeTasks: [earlierTask],
				candidates: [latterTask],
				batchId: 'batch-1',
			});

			// Now latter task CAN proceed!
			expect(evaluation.dispatchable).toHaveLength(1);
			expect(evaluation.dispatchable[0]?.taskId).toBe('task-latter');
			expect(evaluation.blocked).toHaveLength(0);
			expect(evaluation.pathConflictLimit).toBe(1);
		});

		it('E-46: two candidate tasks in the same batch clashing on paths - first is dispatched, second queues behind it', () => {
			const candidate1: TaskPathDescriptor = {
				taskId: 'task-first',
				taskKey: 'M8-T2',
				taskPaths: ['packages/daemon/src/domain/path-clash.ts'],
				batchId: 'batch-1',
			};
			const candidate2: TaskPathDescriptor = {
				taskId: 'task-second',
				taskKey: 'M8-T7',
				taskPaths: ['packages/daemon/src/domain/path-clash.ts'],
				batchId: 'batch-1',
			};

			const evaluation = evaluatePathClashQueue({
				activeTasks: [],
				candidates: [candidate1, candidate2],
				batchId: 'batch-1',
			});

			expect(evaluation.dispatchable).toHaveLength(1);
			expect(evaluation.dispatchable[0]?.taskId).toBe('task-first');

			expect(evaluation.blocked).toHaveLength(1);
			expect(evaluation.blocked[0]?.task.taskId).toBe('task-second');
			expect(evaluation.blocked[0]?.blockedByTaskId).toBe('task-first');
			expect(evaluation.blocked[0]?.blockedByTaskKey).toBe('M8-T2');
			expect(evaluation.blocked[0]?.queuedReason).toBe('path_conflict:M8-T2:task-first');
			expect(evaluation.pathConflictLimit).toBe(1);
		});

		it('allows non-conflicting tasks in the same batch to be dispatched concurrently', () => {
			const candidate1: TaskPathDescriptor = {
				taskId: 'task-a',
				taskKey: 'M8-T1',
				taskPaths: ['packages/daemon/src/domain/concurrency.ts'],
				batchId: 'batch-1',
			};
			const candidate2: TaskPathDescriptor = {
				taskId: 'task-b',
				taskKey: 'M8-T2',
				taskPaths: ['packages/daemon/src/domain/path-clash.ts'],
				batchId: 'batch-1',
			};
			const candidate3: TaskPathDescriptor = {
				taskId: 'task-c',
				taskKey: 'M8-T3',
				taskPaths: ['packages/daemon/src/service/dispatch.ts'],
				batchId: 'batch-1',
			};

			const evaluation = evaluatePathClashQueue({
				activeTasks: [],
				candidates: [candidate1, candidate2, candidate3],
				batchId: 'batch-1',
			});

			expect(evaluation.dispatchable).toHaveLength(3);
			expect(evaluation.blocked).toHaveLength(0);
			expect(evaluation.pathConflictLimit).toBe(3);
		});

		it('does not clash tasks across differing batches when sameBatchOnly is true (default)', () => {
			const batch1Task: TaskPathDescriptor = {
				taskId: 'task-b1',
				taskPaths: ['shared-file.ts'],
				state: 'running',
				batchId: 'batch-1',
			};
			const batch2Task: TaskPathDescriptor = {
				taskId: 'task-b2',
				taskPaths: ['shared-file.ts'],
				state: 'queued',
				batchId: 'batch-2',
			};

			const evalResult = evaluatePathClashQueue({
				activeTasks: [batch1Task],
				candidates: [batch2Task],
				batchId: 'batch-2',
				sameBatchOnly: true,
			});

			// Batch 2 candidate does not clash with Batch 1 active under same-batch rule
			expect(evalResult.dispatchable).toHaveLength(1);
			expect(evalResult.blocked).toHaveLength(0);
		});

		it('enforces clash across differing batches when sameBatchOnly is false (M8-T7 cross-batch wrapup fix)', () => {
			const batch1Task: TaskPathDescriptor = {
				taskId: 'task-b1',
				taskKey: 'M4-T1',
				taskPaths: ['shared-file.ts'],
				state: 'running',
				batchId: 'batch-1',
			};
			const wrapupFixTask: TaskPathDescriptor = {
				taskId: 'task-fix',
				taskKey: 'FIX-M4-T1',
				taskPaths: ['shared-file.ts'],
				state: 'queued',
				batchId: 'batch-2',
			};

			const evalResult = evaluatePathClashQueue({
				activeTasks: [batch1Task],
				candidates: [wrapupFixTask],
				sameBatchOnly: false,
			});

			expect(evalResult.dispatchable).toHaveLength(0);
			expect(evalResult.blocked).toHaveLength(1);
			expect(evalResult.blocked[0]?.blockedByTaskId).toBe('task-b1');
		});
	});

	describe('queuedReason formatting and parsing', () => {
		it('builds and parses path conflict queued reasons correctly', () => {
			const reason1 = buildPathConflictReason('task-123');
			expect(reason1).toBe('path_conflict:task-123');
			expect(isPathConflictReason(reason1)).toBe(true);
			expect(parsePathConflictReason(reason1)).toEqual({
				blockerTaskId: 'task-123',
			});

			const reason2 = buildPathConflictReason('task-456', { taskKey: 'M8-T1' });
			expect(reason2).toBe('path_conflict:M8-T1:task-456');
			expect(parsePathConflictReason(reason2)).toEqual({
				taskKey: 'M8-T1',
				blockerTaskId: 'task-456',
			});

			const reason3 = buildPathConflictReason('task-789', {
				taskKey: 'M8-T2',
				runId: 'run-999',
			});
			expect(reason3).toBe('path_conflict:M8-T2:task-789:run-999');
			expect(parsePathConflictReason(reason3)).toEqual({
				taskKey: 'M8-T2',
				blockerTaskId: 'task-789',
				runId: 'run-999',
			});

			expect(isPathConflictReason('other_reason')).toBe(false);
			expect(parsePathConflictReason('other_reason')).toBeNull();
			expect(parsePathConflictReason(null)).toBeNull();
		});

		it('builds and parses wrapup fix serial reasons correctly (M8-T7 forward compatibility)', () => {
			const reason = buildWrapupFixSerialReason('run-wrapup-123');
			expect(reason).toBe('wrapup-fix-serial:run-wrapup-123');
			expect(isWrapupFixSerialReason(reason)).toBe(true);
			expect(parseWrapupFixSerialReason(reason)).toEqual({
				runId: 'run-wrapup-123',
			});

			expect(isWrapupFixSerialReason('path_conflict:task-1')).toBe(false);
			expect(parseWrapupFixSerialReason('path_conflict:task-1')).toBeNull();
		});

		it('throws AppError E_VALIDATION on invalid inputs to builders', () => {
			expect(() => buildPathConflictReason('')).toThrow(AppError);
			expect(() => buildWrapupFixSerialReason('')).toThrow(AppError);
			// @ts-expect-error test invalid candidates input
			expect(() => evaluatePathClashQueue({})).toThrow(AppError);
		});
	});
});
