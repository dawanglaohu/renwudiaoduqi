import * as nodePath from 'node:path';
import type { RunBaseRef } from '@agent-scheduler/shared/api/runs';
import { AppError } from '../errors/app-error.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import {
	type GitRunner,
	type WorktreeManager,
	type WorktreeManagerDeps,
	createDefaultGitRunner,
	prepareWorktree,
} from './worktree.ts';

export type UpstreamBranchCheckMethod =
	| 'ancestor'
	| 'no_diff'
	| 'unmerged'
	| 'dirty_worktree'
	| 'branch_missing'
	| 'branch_gone'
	| 'branch_gone_unmerged'
	| 'error';

export interface UpstreamBranchCheckResult {
	readonly isInHead: boolean;
	readonly method: UpstreamBranchCheckMethod;
	readonly tipSha?: string;
	readonly branchName?: string;
	readonly reason?: string;
	readonly commandText?: string;
	readonly stderrTail?: string;
}

export interface UpstreamTaskInfo {
	readonly taskId: string;
	readonly branchName?: string;
	readonly isLanded?: boolean;
	readonly worktreePath?: string;
	readonly tipSha?: string;
}

export interface UpstreamTaskStatus extends UpstreamTaskInfo, UpstreamBranchCheckResult {}

export interface AvailableUpstreamBase {
	readonly kind: 'upstreamBranch';
	readonly taskKey: string;
	readonly branchName: string;
	readonly label: string;
}

export interface BaseResolutionResult {
	readonly resolvedBase: string;
	readonly baseKind: 'head' | 'upstreamBranch';
	readonly upstreamTaskId?: string;
	readonly unmergedUpstreams: readonly UpstreamTaskStatus[];
}

export interface ResolveTaskBaseInput {
	readonly repoPath: string;
	readonly taskId: string;
	readonly upstreamTasks?: readonly UpstreamTaskInfo[];
	readonly baseRef?: RunBaseRef;
}

export type TaskWorkspaceStrategy = 'git_worktree' | 'agent_native';

export interface PrepareTaskWorkspaceInput {
	readonly repoPath: string;
	readonly taskId: string;
	readonly agentId: string;
	readonly sessionId?: string;
	readonly upstreamTasks?: readonly UpstreamTaskInfo[];
	readonly baseRef?: RunBaseRef;
	readonly worktreeMode?: 'fresh' | 'reuse';
	readonly targetWorktreePath?: string;
	readonly worktreesDir?: string;
	readonly currentActiveRuns?: number;
	readonly maxConcurrency?: number;
	readonly supportsNativeWorktree?: boolean;
}

export interface PrepareTaskWorkspaceResult {
	readonly taskId: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseRef: string;
	readonly baseKind: 'head' | 'upstreamBranch';
	readonly strategy: TaskWorkspaceStrategy;
	readonly nativeArgs?: readonly string[];
	readonly isReused: boolean;
}

export interface BaseSelectorDeps {
	readonly platform?: SupportedPlatform;
	readonly gitRunner?: GitRunner;
	readonly worktreeManager?: WorktreeManager;
	readonly ids?: { readonly newId: () => string };
	readonly clock?: { readonly now: () => string };
	readonly homedir?: string;
	readonly worktreeDeps?: WorktreeManagerDeps;
}

export interface BaseSelector {
	checkUpstreamBranchInHead(
		repoPath: string,
		upstream: UpstreamTaskInfo,
	): Promise<UpstreamBranchCheckResult>;
	validateUpstreamOutputs(
		repoPath: string,
		upstreamTasks: readonly UpstreamTaskInfo[],
	): Promise<{
		readonly allLanded: boolean;
		readonly unmergedUpstreams: readonly UpstreamTaskStatus[];
	}>;
	resolveTaskBase(input: ResolveTaskBaseInput): Promise<BaseResolutionResult>;
	checkAgentConcurrency(agentId: string, currentActiveRuns: number, maxConcurrency: number): void;
	prepareTaskWorkspace(input: PrepareTaskWorkspaceInput): Promise<PrepareTaskWorkspaceResult>;
}

/**
 * Checks whether an upstream task's output has been landed into current HEAD.
 *
 * Boundary E-70 & E-273:
 * 1. Checks if the upstream worktree has uncommitted changes (dirty_worktree).
 * 2. Checks if the branch exists locally in refs/heads/:
 *    - git merge-base --is-ancestor <branch> HEAD: exit 0 -> ancestor
 *    - git diff --quiet HEAD <branch>: exit 0 -> no_diff (E-273 squash merge fallback)
 *    - otherwise -> unmerged
 * 3. If branch does not exist locally:
 *    - Checks tipSha if provided: merge-base -> diff -> branch_gone_unmerged
 *    - If task marked isLanded: branch_gone
 *    - Otherwise: branch_missing
 */
export async function checkUpstreamBranchInHead(
	repoPath: string,
	upstream: UpstreamTaskInfo,
	runner: GitRunner,
): Promise<UpstreamBranchCheckResult> {
	const resolvedRepo = nodePath.resolve(repoPath);
	const branchName = upstream.branchName ?? `task/${upstream.taskId}`;

	// 1. Check if upstream worktree exists and has uncommitted changes (dirty_worktree, E-301)
	if (upstream.worktreePath) {
		try {
			const statusResult = await runner.run(['status', '--porcelain'], upstream.worktreePath);
			if (statusResult.exitCode === 0) {
				const lines = statusResult.stdout
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter((l) => l.length > 0);
				if (lines.length > 0) {
					return Object.freeze({
						isInHead: false,
						method: 'dirty_worktree',
						branchName,
						reason: `Upstream task '${upstream.taskId}' worktree has ${lines.length} uncommitted file change(s)`,
					});
				}
			}
		} catch {
			// If worktree directory doesn't exist or isn't accessible, proceed to branch checks
		}
	}

	// 2. Check if the branch exists locally in refs/heads/
	const branchCheck = await runner.run(
		['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
		resolvedRepo,
	);

	if (branchCheck.exitCode === 0) {
		const tipSha = branchCheck.stdout.trim() || undefined;

		// 2a. Ancestor check: git merge-base --is-ancestor <branch> HEAD
		const ancestorCheck = await runner.run(
			['merge-base', '--is-ancestor', `refs/heads/${branchName}`, 'HEAD'],
			resolvedRepo,
		);

		if (ancestorCheck.exitCode === 0) {
			return Object.freeze({
				isInHead: true,
				method: 'ancestor',
				branchName,
				tipSha,
			});
		}

		if (ancestorCheck.exitCode === 1) {
			// 2b. Fallback: git diff --quiet HEAD <branch> (E-273 squash merge)
			const diffCheck = await runner.run(
				['diff', '--quiet', 'HEAD', `refs/heads/${branchName}`],
				resolvedRepo,
			);

			if (diffCheck.exitCode === 0) {
				return Object.freeze({
					isInHead: true,
					method: 'no_diff',
					branchName,
					tipSha,
				});
			}

			if (diffCheck.exitCode === 1) {
				return Object.freeze({
					isInHead: false,
					method: 'unmerged',
					branchName,
					tipSha,
					reason: `Upstream branch '${branchName}' has changes not merged into HEAD (squash/ancestor diff non-empty)`,
				});
			}

			return Object.freeze({
				isInHead: false,
				method: 'error',
				branchName,
				tipSha,
				stderrTail: diffCheck.stderr.slice(-200),
				reason: `Git error during diff comparison: ${diffCheck.stderr || diffCheck.stdout}`,
			});
		}

		return Object.freeze({
			isInHead: false,
			method: 'error',
			branchName,
			tipSha,
			stderrTail: ancestorCheck.stderr.slice(-200),
			reason: `Git error during merge-base check: ${ancestorCheck.stderr || ancestorCheck.stdout}`,
		});
	}

	// 3. Branch does NOT exist locally in refs/heads/
	// 3a. If tipSha is provided, check tipSha against HEAD
	if (upstream.tipSha && upstream.tipSha.trim().length > 0) {
		const sha = upstream.tipSha.trim();
		const shaCheck = await runner.run(['rev-parse', '--verify', '--quiet', sha], resolvedRepo);

		if (shaCheck.exitCode === 0) {
			const ancestorCheck = await runner.run(
				['merge-base', '--is-ancestor', sha, 'HEAD'],
				resolvedRepo,
			);
			if (ancestorCheck.exitCode === 0) {
				return Object.freeze({
					isInHead: true,
					method: 'ancestor',
					branchName,
					tipSha: sha,
				});
			}

			if (ancestorCheck.exitCode === 1) {
				const diffCheck = await runner.run(['diff', '--quiet', 'HEAD', sha], resolvedRepo);
				if (diffCheck.exitCode === 0) {
					return Object.freeze({
						isInHead: true,
						method: 'no_diff',
						branchName,
						tipSha: sha,
					});
				}

				return Object.freeze({
					isInHead: false,
					method: 'branch_gone_unmerged',
					branchName,
					tipSha: sha,
					commandText: `git branch ${branchName} ${sha}`,
					reason: `Branch '${branchName}' is gone locally and tip SHA '${sha}' is not in HEAD`,
				});
			}
		}
	}

	// 3b. Branch is gone locally and no valid tip SHA
	if (upstream.isLanded === true) {
		return Object.freeze({
			isInHead: true,
			method: 'branch_gone',
			branchName,
			reason: `Upstream task '${upstream.taskId}' is marked landed and branch '${branchName}' has been cleaned up`,
		});
	}

	return Object.freeze({
		isInHead: false,
		method: 'branch_missing',
		branchName,
		reason: `Upstream branch '${branchName}' does not exist locally and task '${upstream.taskId}' is not landed`,
	});
}

/**
 * Validates all upstream tasks of a target task.
 */
export async function validateUpstreamOutputs(
	repoPath: string,
	upstreamTasks: readonly UpstreamTaskInfo[],
	runner: GitRunner,
): Promise<{
	readonly allLanded: boolean;
	readonly unmergedUpstreams: readonly UpstreamTaskStatus[];
}> {
	const unmergedUpstreams: UpstreamTaskStatus[] = [];

	for (const upstream of upstreamTasks) {
		const checkResult = await checkUpstreamBranchInHead(repoPath, upstream, runner);
		if (!checkResult.isInHead) {
			unmergedUpstreams.push(
				Object.freeze({
					...upstream,
					...checkResult,
				}),
			);
		}
	}

	return Object.freeze({
		allLanded: unmergedUpstreams.length === 0,
		unmergedUpstreams: Object.freeze(unmergedUpstreams),
	});
}

/**
 * Resolves the base reference for a task being dispatched (AC 1, AC 2, E-70).
 *
 * AC 1 & E-70:
 * When upstream task output is not landed into current HEAD and baseRef is 'head' (default):
 * Rejects dispatch with E_UPSTREAM_BASE_MISSING and explanation "下游 base 缺上游产出".
 *
 * AC 2 & E-70:
 * Provides explicit option "以上游任务分支为 base 建 worktree" (baseRef.kind === 'upstreamBranch').
 * Never silently starts from an outdated HEAD.
 */
export async function resolveTaskBase(
	input: ResolveTaskBaseInput,
	runner: GitRunner,
): Promise<BaseResolutionResult> {
	const upstreamTasks = input.upstreamTasks ?? [];
	const validation = await validateUpstreamOutputs(input.repoPath, upstreamTasks, runner);

	const requestedRef = input.baseRef;
	const isUpstreamBranchKind = requestedRef?.kind === 'upstreamBranch';

	if (validation.unmergedUpstreams.length > 0) {
		// E-70: 上游任务改动尚未落地进当前 HEAD 就要派下游
		if (!isUpstreamBranchKind) {
			// AC 1: 拒绝派发并说明「下游 base 缺上游产出」（E-70）
			// AC 2: 同时提供「以上游任务分支为 base 建 worktree」的显式选项，绝不默默从旧 HEAD 起
			const availableUpstreamBases: AvailableUpstreamBase[] = validation.unmergedUpstreams.map(
				(u) => ({
					kind: 'upstreamBranch',
					taskKey: u.taskId,
					branchName: u.branchName ?? `task/${u.taskId}`,
					label: `以上游任务分支 ${u.branchName ?? `task/${u.taskId}`} 为 base 建 worktree`,
				}),
			);

			const suggestedTaskKey =
				validation.unmergedUpstreams[0]?.taskId ?? upstreamTasks[0]?.taskId ?? '';

			throw new AppError(
				'E_UPSTREAM_BASE_MISSING',
				`Downstream task '${input.taskId}' base is missing upstream output. Upstream changes have not been landed into HEAD.`,
				{
					details: {
						taskId: input.taskId,
						reason: '下游 base 缺上游产出',
						unmergedUpstreams: validation.unmergedUpstreams,
						availableUpstreamBases: Object.freeze(availableUpstreamBases),
						suggestedBaseRef: Object.freeze({
							kind: 'upstreamBranch',
							taskKey: suggestedTaskKey,
						}),
					},
				},
			);
		}

		// Explicit option requested: kind === 'upstreamBranch' (AC 2, E-70)
		let targetTask: UpstreamTaskInfo;
		if (requestedRef.taskKey) {
			const found = upstreamTasks.find((u) => u.taskId === requestedRef.taskKey);
			if (!found) {
				throw new AppError(
					'E_VALIDATION',
					`Specified baseRef.taskKey '${requestedRef.taskKey}' is not an upstream dependency of task '${input.taskId}'.`,
					{ details: { taskId: input.taskId, taskKey: requestedRef.taskKey } },
				);
			}
			targetTask = found;
		} else {
			if (validation.unmergedUpstreams.length === 1) {
				const single = validation.unmergedUpstreams[0];
				if (!single) {
					throw new AppError('E_VALIDATION', 'No unmerged upstream task available.');
				}
				targetTask = single;
			} else {
				throw new AppError(
					'E_VALIDATION',
					`Multiple unmerged upstream tasks exist for task '${input.taskId}'; taskKey must be specified in baseRef.`,
					{
						details: {
							taskId: input.taskId,
							availableUpstreamBases: validation.unmergedUpstreams.map((u) => ({
								kind: 'upstreamBranch',
								taskKey: u.taskId,
								branchName: u.branchName ?? `task/${u.taskId}`,
								label: `以上游任务分支 ${u.branchName ?? `task/${u.taskId}`} 为 base 建 worktree`,
							})),
						},
					},
				);
			}
		}

		const resolvedBase = targetTask.branchName ?? `task/${targetTask.taskId}`;

		// Verify that the requested upstream branch exists in the repository
		const branchCheck = await runner.run(
			['rev-parse', '--verify', '--quiet', `refs/heads/${resolvedBase}`],
			nodePath.resolve(input.repoPath),
		);
		if (branchCheck.exitCode !== 0) {
			throw new AppError(
				'E_VALIDATION',
				`Upstream branch '${resolvedBase}' for task '${targetTask.taskId}' does not exist in repository.`,
				{
					details: {
						taskId: input.taskId,
						taskKey: targetTask.taskId,
						branchName: resolvedBase,
					},
				},
			);
		}

		return Object.freeze({
			resolvedBase,
			baseKind: 'upstreamBranch',
			upstreamTaskId: targetTask.taskId,
			unmergedUpstreams: validation.unmergedUpstreams,
		});
	}

	// All upstream outputs are in HEAD (or task has no upstream dependencies)
	if (isUpstreamBranchKind && requestedRef.taskKey) {
		const targetTask = upstreamTasks.find((u) => u.taskId === requestedRef.taskKey);
		if (!targetTask) {
			throw new AppError(
				'E_VALIDATION',
				`Specified baseRef.taskKey '${requestedRef.taskKey}' is not an upstream dependency of task '${input.taskId}'.`,
				{ details: { taskId: input.taskId, taskKey: requestedRef.taskKey } },
			);
		}
		const resolvedBase = targetTask.branchName ?? `task/${targetTask.taskId}`;
		return Object.freeze({
			resolvedBase,
			baseKind: 'upstreamBranch',
			upstreamTaskId: targetTask.taskId,
			unmergedUpstreams: validation.unmergedUpstreams,
		});
	}

	return Object.freeze({
		resolvedBase: 'HEAD',
		baseKind: 'head',
		unmergedUpstreams: validation.unmergedUpstreams,
	});
}

/**
 * Validates agent concurrency limit (AC 3, E-31).
 * Throws E_AGENT_BUSY (429 retryable) when current active runs reach or exceed limit.
 * Throws E_AGENT_UNAVAILABLE (409) when maxConcurrency is <= 0 (disabled).
 */
export function checkAgentConcurrency(
	agentId: string,
	currentActiveRuns: number,
	maxConcurrency: number,
): void {
	if (
		typeof maxConcurrency !== 'number' ||
		!Number.isFinite(maxConcurrency) ||
		maxConcurrency <= 0
	) {
		throw new AppError(
			'E_AGENT_UNAVAILABLE',
			`Agent '${agentId}' is unavailable: maxConcurrency must be a positive integer > 0 (received ${maxConcurrency}).`,
			{ details: { agentId, maxConcurrency } },
		);
	}

	const limit = Math.floor(maxConcurrency);
	const active = Math.max(0, Math.floor(currentActiveRuns));

	if (active >= limit) {
		throw new AppError(
			'E_AGENT_BUSY',
			`Agent '${agentId}' has reached its concurrency limit of ${limit} (currently active runs: ${active}).`,
			{
				details: {
					agentId,
					currentActiveRuns: active,
					maxConcurrency: limit,
				},
			},
		);
	}
}

/**
 * Prepares task workspace and validates base, sessions, and agent limits (AC 1, AC 2, AC 3, E-31, E-70).
 *
 * - Independent session and workspace per task (E-31).
 * - Grok uses native --worktree, others use git worktree fallback (E-31).
 * - Enforces per-agent concurrency limits (E-31).
 * - Validates upstream outputs and rejects starting from outdated HEAD (E-70).
 */
export async function prepareTaskWorkspace(
	input: PrepareTaskWorkspaceInput,
	runner: GitRunner,
	deps: BaseSelectorDeps,
): Promise<PrepareTaskWorkspaceResult> {
	const agentId = input.agentId.trim();
	if (agentId.length === 0) {
		throw new AppError('E_VALIDATION', 'agentId must not be empty');
	}
	const taskId = input.taskId.trim();
	if (taskId.length === 0) {
		throw new AppError('E_VALIDATION', 'taskId must not be empty');
	}

	// 1. Check per-agent concurrency limit if provided (AC 3, E-31)
	if (input.currentActiveRuns !== undefined && input.maxConcurrency !== undefined) {
		checkAgentConcurrency(agentId, input.currentActiveRuns, input.maxConcurrency);
	}

	// 2. Resolve base and validate upstream output (AC 1, AC 2, E-70)
	const baseResolution = await resolveTaskBase(
		{
			repoPath: input.repoPath,
			taskId,
			upstreamTasks: input.upstreamTasks,
			baseRef: input.baseRef,
		},
		runner,
	);

	// 3. Generate independent session ID (AC 3, E-31)
	// Session ids come from the injected id source only: a clock-derived fallback would make
	// two dispatches within the same millisecond collide and is not reproducible in tests.
	const sessionId = input.sessionId ?? (deps.ids ? `sess_${deps.ids.newId()}` : undefined);
	if (!sessionId) {
		throw new AppError(
			'E_INTERNAL',
			`prepareTaskWorkspace for task '${taskId}' has no session id: pass input.sessionId or deps.ids.newId.`,
		);
	}

	// 4. Determine workspace strategy: grok native --worktree vs git worktree fallback (E-31)
	const isGrok = agentId.toLowerCase() === 'grok';
	const supportsNativeWorktree = input.supportsNativeWorktree ?? isGrok;

	if (supportsNativeWorktree) {
		// Grok manages its own worktree natively using --worktree and --worktree-ref
		const repoName = nodePath.basename(nodePath.resolve(input.repoPath));
		const parentDir = input.worktreesDir
			? nodePath.resolve(input.worktreesDir)
			: nodePath.dirname(nodePath.resolve(input.repoPath));
		const sanitizedTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase();
		const worktreePath = input.targetWorktreePath
			? nodePath.resolve(input.targetWorktreePath)
			: nodePath.resolve(parentDir, `${repoName}-${sanitizedTaskId}`);
		const branchName = `task/${taskId}`;

		return Object.freeze({
			taskId,
			agentId,
			sessionId,
			worktreePath,
			branchName,
			baseRef: baseResolution.resolvedBase,
			baseKind: baseResolution.baseKind,
			strategy: 'agent_native',
			nativeArgs: Object.freeze([
				'--worktree',
				worktreePath,
				'--worktree-ref',
				baseResolution.resolvedBase,
			]),
			isReused: false,
		});
	}

	// Other agents use git worktree fallback (AC 3, E-31)
	const worktreeResult = deps.worktreeManager
		? await deps.worktreeManager.prepareWorktree({
				repoPath: input.repoPath,
				taskId,
				baseRef: baseResolution.resolvedBase,
				worktreeMode: input.worktreeMode,
				targetWorktreePath: input.targetWorktreePath,
				worktreesDir: input.worktreesDir,
			})
		: await prepareWorktree(
				{
					repoPath: input.repoPath,
					taskId,
					baseRef: baseResolution.resolvedBase,
					worktreeMode: input.worktreeMode,
					targetWorktreePath: input.targetWorktreePath,
					worktreesDir: input.worktreesDir,
				},
				runner,
				deps.worktreeDeps ?? {
					platform: deps.platform ?? 'linux',
					gitRunner: runner,
					ids: deps.ids ?? { newId: () => sessionId },
				},
			);

	return Object.freeze({
		taskId,
		agentId,
		sessionId,
		worktreePath: worktreeResult.worktreePath,
		branchName: worktreeResult.branchName,
		baseRef: worktreeResult.baseRef,
		baseKind: baseResolution.baseKind,
		strategy: 'git_worktree',
		isReused: worktreeResult.isReused,
	});
}

/**
 * Factory for BaseSelector instance.
 */
export function createBaseSelector(deps: BaseSelectorDeps): BaseSelector {
	const runner =
		deps.gitRunner ?? (deps.worktreeDeps ? createDefaultGitRunner(deps.worktreeDeps) : undefined);

	function getRunner(): GitRunner {
		if (!runner) {
			throw new AppError(
				'E_INTERNAL',
				'GitRunner is required for BaseSelector operations but none was provided.',
			);
		}
		return runner;
	}

	return Object.freeze({
		async checkUpstreamBranchInHead(repoPath: string, upstream: UpstreamTaskInfo) {
			return checkUpstreamBranchInHead(repoPath, upstream, getRunner());
		},
		async validateUpstreamOutputs(repoPath: string, upstreamTasks: readonly UpstreamTaskInfo[]) {
			return validateUpstreamOutputs(repoPath, upstreamTasks, getRunner());
		},
		async resolveTaskBase(input: ResolveTaskBaseInput) {
			return resolveTaskBase(input, getRunner());
		},
		checkAgentConcurrency(agentId: string, currentActiveRuns: number, maxConcurrency: number) {
			return checkAgentConcurrency(agentId, currentActiveRuns, maxConcurrency);
		},
		async prepareTaskWorkspace(input: PrepareTaskWorkspaceInput) {
			return prepareTaskWorkspace(input, getRunner(), deps);
		},
	});
}
