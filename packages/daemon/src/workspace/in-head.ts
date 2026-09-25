import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { AppError } from '../errors/app-error.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import { takePlatformHostInputs } from '../platform/host.ts';
import type { spawnManaged } from '../proc/spawn.ts';
import {
	type GitCommandResult,
	type GitRunner,
	type WorktreeFileSystem,
	type WorktreeManagerDeps,
	createDefaultGitRunner,
} from './worktree.ts';

export {
	type PrepareWrapupWorktreeInput,
	type PrepareWrapupWorktreeResult,
	formatWrapupBranchName,
	prepareWrapupWorktree,
	resolveWrapupBranchName,
} from './worktree.ts';

export type InHeadCheckMethod =
	| 'ancestor'
	| 'no_diff'
	| 'dirty_worktree'
	| 'branch_gone'
	| 'branch_gone_unmerged'
	| 'unmerged'
	| 'error';

export interface IsBranchInHeadInput {
	readonly repoPath: string;
	readonly branchName: string;
	readonly worktreePath?: string;
	readonly tipSha?: string;
}

export interface IsBranchInHeadResult {
	readonly inHead: boolean;
	readonly method: InHeadCheckMethod;
	readonly tipSha?: string;
	readonly commandText?: string;
	readonly stderrTail?: string;
}

export interface IsBranchInHeadDeps {
	readonly gitRunner?: GitRunner;
	readonly fs?: WorktreeFileSystem;
	readonly platform?: SupportedPlatform;
	readonly spawnManaged?: typeof spawnManaged;
	readonly ids?: { readonly newId: () => string };
}

/**
 * Takes at most `maxBytes` (default 200) from the tail of a string (UTF-8 encoded).
 */
export function takeStderrTail(text: string, maxBytes = 200): string {
	if (!text) return '';
	const buf = Buffer.from(text, 'utf-8');
	if (buf.length <= maxBytes) {
		return text;
	}
	const slice = buf.subarray(buf.length - maxBytes);
	return slice.toString('utf-8');
}

function resolvePlatform(configuredPlatform?: SupportedPlatform): SupportedPlatform {
	if (configuredPlatform) {
		return configuredPlatform;
	}
	const hostResult = takePlatformHostInputs({});
	if (hostResult.ok) {
		return hostResult.value.platform;
	}
	return 'linux';
}

function resolveGitRunner(depsOrRunner?: GitRunner | IsBranchInHeadDeps): {
	runner: GitRunner;
	fs?: WorktreeFileSystem;
} {
	if (depsOrRunner && 'run' in depsOrRunner && typeof depsOrRunner.run === 'function') {
		return { runner: depsOrRunner };
	}

	if (depsOrRunner && typeof depsOrRunner === 'object') {
		const deps = depsOrRunner as IsBranchInHeadDeps;
		if (deps.gitRunner) {
			return { runner: deps.gitRunner, fs: deps.fs };
		}
		const managerDeps: WorktreeManagerDeps = {
			platform: resolvePlatform(deps.platform),
			spawnManaged: deps.spawnManaged,
			ids: deps.ids ?? { newId: () => 'git-runner-id' },
			fs: deps.fs,
		};
		return { runner: createDefaultGitRunner(managerDeps), fs: deps.fs };
	}

	const managerDeps: WorktreeManagerDeps = {
		platform: resolvePlatform(),
		ids: { newId: () => 'git-runner-id' },
	};
	return { runner: createDefaultGitRunner(managerDeps) };
}

/**
 * Determines whether a branch has been landed into the repository HEAD.
 *
 * All git calls go through GitRunner (backed by proc/spawn) and are executed sequentially (AC 4).
 * This function does NOT write to the database (AC 4).
 *
 * Rules:
 * 1. If worktreePath exists and `git status --porcelain` is non-empty -> not in HEAD (method='dirty_worktree', AC 1, E-301).
 * 2. If branch exists locally:
 *    - `git merge-base --is-ancestor <branch> HEAD` exit 0 -> in HEAD (method='ancestor', AC 1).
 *    - exit 1 fallback `git diff --quiet HEAD <branch>` exit 0 -> in HEAD (method='no_diff', AC 1, E-273).
 *    - exit 1 with diff -> not in HEAD (method='unmerged', E-273).
 * 3. If branch does NOT exist locally:
 *    - If tipSha provided (or recoverable from existing worktree HEAD):
 *      Same ancestor & diff checks. If both fail -> not in HEAD (method='branch_gone_unmerged', AC 2, E-289)
 *      with commandText=`git branch <branchName> <sha>`.
 *    - If no tipSha and worktree cleaned up -> in HEAD (method='branch_gone', AC 2, E-289).
 *      A worktree that is still present but whose HEAD is unreadable, or whose presence cannot be
 *      determined, is NOT this case: report method='error' and never infer "already merged" (E-301).
 * 4. Any git command error -> method='error' with last 200 bytes of stderr (AC 3, E-301).
 */
export async function isBranchInHead(
	input: IsBranchInHeadInput,
	depsOrRunner?: GitRunner | IsBranchInHeadDeps,
): Promise<IsBranchInHeadResult> {
	const { runner, fs } = resolveGitRunner(depsOrRunner);
	const repoPath = nodePath.resolve(input.repoPath);
	const branchName = input.branchName.trim();
	let tipSha = input.tipSha?.trim() || undefined;

	// 'not-provided': caller passed no worktreePath; 'absent': confirmed gone;
	// 'present': confirmed there; 'unknown': stat failed for a reason other than ENOENT.
	let worktreePresence: 'not-provided' | 'absent' | 'present' | 'unknown' = input.worktreePath
		? 'absent'
		: 'not-provided';
	let worktreeHeadSha: string | undefined = undefined;
	let worktreeDiagnostic: string | undefined = undefined;

	// Step 1: Check worktreePath existence and dirty status (AC 1, E-301)
	if (input.worktreePath) {
		const resolvedWorktreePath = nodePath.resolve(input.worktreePath);
		try {
			const stat = fs?.stat
				? await fs.stat(resolvedWorktreePath)
				: await nodeFs.stat(resolvedWorktreePath);
			worktreePresence = stat.isDirectory() ? 'present' : 'absent';
		} catch (cause) {
			const code = (cause as { code?: string } | undefined)?.code;
			worktreePresence = code === 'ENOENT' ? 'absent' : 'unknown';
			if (worktreePresence === 'unknown') {
				worktreeDiagnostic = cause instanceof Error ? cause.message : String(cause);
			}
		}

		if (worktreePresence === 'present') {
			let statusResult: GitCommandResult;
			try {
				statusResult = await runner.run(['status', '--porcelain'], resolvedWorktreePath);
			} catch (cause) {
				return Object.freeze({
					inHead: false,
					method: 'error',
					tipSha,
					stderrTail: takeStderrTail(cause instanceof Error ? cause.message : String(cause)),
				});
			}

			if (statusResult.exitCode !== 0) {
				return Object.freeze({
					inHead: false,
					method: 'error',
					tipSha,
					stderrTail: takeStderrTail(statusResult.stderr || statusResult.stdout),
				});
			}

			const porcelainLines = statusResult.stdout
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter((l) => l.length > 0);

			if (porcelainLines.length > 0) {
				// Worktree has uncommitted changes -> always not in HEAD (AC 1, E-301)
				if (!tipSha) {
					try {
						const headResult = await runner.run(['rev-parse', 'HEAD'], resolvedWorktreePath);
						if (headResult.exitCode === 0 && headResult.stdout.trim().length > 0) {
							tipSha = headResult.stdout.trim();
						}
					} catch {
						// Ignore secondary failure
					}
				}
				return Object.freeze({
					inHead: false,
					method: 'dirty_worktree',
					tipSha,
				});
			}

			// Clean worktree: attempt reading HEAD sha for later fallback if needed (E-289).
			// A failure here is not ignorable: without it we cannot tell "landed" from "unknown".
			try {
				const headResult = await runner.run(['rev-parse', 'HEAD'], resolvedWorktreePath);
				if (headResult.exitCode === 0 && headResult.stdout.trim().length > 0) {
					worktreeHeadSha = headResult.stdout.trim();
				} else {
					worktreeDiagnostic =
						headResult.stderr.trim() || `git rev-parse HEAD exited ${headResult.exitCode}`;
				}
			} catch (cause) {
				worktreeDiagnostic = cause instanceof Error ? cause.message : String(cause);
			}
		}
	}

	// Step 2: Check if branch exists locally
	let branchExists = false;
	try {
		const branchCheck = await runner.run(
			['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
			repoPath,
		);

		if (branchCheck.exitCode === 0) {
			branchExists = true;
			const branchSha = branchCheck.stdout.trim();
			if (branchSha.length > 0) {
				tipSha = branchSha;
			}
		} else if (branchCheck.exitCode !== 1 && branchCheck.stderr.trim().length > 0) {
			// Severe git error (e.g. not a git repo or corrupted)
			return Object.freeze({
				inHead: false,
				method: 'error',
				tipSha,
				stderrTail: takeStderrTail(branchCheck.stderr || branchCheck.stdout),
			});
		}
	} catch (cause) {
		return Object.freeze({
			inHead: false,
			method: 'error',
			tipSha,
			stderrTail: takeStderrTail(cause instanceof Error ? cause.message : String(cause)),
		});
	}

	// Step 3: Branch exists locally -> test merge-base and fallback to diff (AC 1, E-273)
	if (branchExists) {
		try {
			const ancestorResult = await runner.run(
				['merge-base', '--is-ancestor', `refs/heads/${branchName}`, 'HEAD'],
				repoPath,
			);

			if (ancestorResult.exitCode === 0) {
				return Object.freeze({
					inHead: true,
					method: 'ancestor',
					tipSha,
				});
			}

			if (ancestorResult.exitCode === 1) {
				// Fallback to git diff --quiet HEAD <branch> (E-273)
				const diffResult = await runner.run(
					['diff', '--quiet', 'HEAD', `refs/heads/${branchName}`],
					repoPath,
				);

				if (diffResult.exitCode === 0) {
					return Object.freeze({
						inHead: true,
						method: 'no_diff',
						tipSha,
					});
				}

				if (diffResult.exitCode === 1) {
					return Object.freeze({
						inHead: false,
						method: 'unmerged',
						tipSha,
					});
				}

				return Object.freeze({
					inHead: false,
					method: 'error',
					tipSha,
					stderrTail: takeStderrTail(diffResult.stderr || diffResult.stdout),
				});
			}

			return Object.freeze({
				inHead: false,
				method: 'error',
				tipSha,
				stderrTail: takeStderrTail(ancestorResult.stderr || ancestorResult.stdout),
			});
		} catch (cause) {
			return Object.freeze({
				inHead: false,
				method: 'error',
				tipSha,
				stderrTail: takeStderrTail(cause instanceof Error ? cause.message : String(cause)),
			});
		}
	}

	// Step 4: Branch does not exist locally (AC 2, E-289)
	const targetSha = tipSha || (worktreePresence === 'present' ? worktreeHeadSha : undefined);

	if (!targetSha) {
		// E-289 only allows assuming "landed" once the worktree is confirmed gone. A worktree that is
		// still present but whose HEAD is unreadable, or whose state we could not determine, is an
		// undeterminable case: never infer "already merged" (E-301), report method='error' instead.
		if (worktreePresence === 'present' || worktreePresence === 'unknown') {
			return Object.freeze({
				inHead: false,
				method: 'error',
				tipSha: undefined,
				stderrTail: takeStderrTail(
					worktreeDiagnostic ?? `Unable to determine worktree HEAD for ${branchName}`,
				),
			});
		}
		return Object.freeze({
			inHead: true,
			method: 'branch_gone',
			tipSha: undefined,
		});
	}

	try {
		// Test target SHA with the same ancestor and diff rules
		const ancestorResult = await runner.run(
			['merge-base', '--is-ancestor', targetSha, 'HEAD'],
			repoPath,
		);

		if (ancestorResult.exitCode === 0) {
			return Object.freeze({
				inHead: true,
				method: 'ancestor',
				tipSha: targetSha,
			});
		}

		if (ancestorResult.exitCode === 1) {
			const diffResult = await runner.run(['diff', '--quiet', 'HEAD', targetSha], repoPath);

			if (diffResult.exitCode === 0) {
				return Object.freeze({
					inHead: true,
					method: 'no_diff',
					tipSha: targetSha,
				});
			}

			if (diffResult.exitCode === 1) {
				// Both false -> unmerged with branch restore command
				return Object.freeze({
					inHead: false,
					method: 'branch_gone_unmerged',
					tipSha: targetSha,
					commandText: `git branch ${branchName} ${targetSha}`,
				});
			}

			return Object.freeze({
				inHead: false,
				method: 'error',
				tipSha: targetSha,
				stderrTail: takeStderrTail(diffResult.stderr || diffResult.stdout),
			});
		}

		return Object.freeze({
			inHead: false,
			method: 'error',
			tipSha: targetSha,
			stderrTail: takeStderrTail(ancestorResult.stderr || ancestorResult.stdout),
		});
	} catch (cause) {
		return Object.freeze({
			inHead: false,
			method: 'error',
			tipSha: targetSha,
			stderrTail: takeStderrTail(cause instanceof Error ? cause.message : String(cause)),
		});
	}
}

export interface WorktreeStartingBaseline {
	readonly headSha: string;
	readonly treeSha: string;
}

/**
 * 读工作区的起点树基线（HEAD SHA 与工作区树对象，E-329）。
 * 供查 bug 阶段判定 FIXED、再审 diff 与自审查 pass 以来工作区 diff 的基线。
 * 不在 service 拼 git 命令，全走 runner。
 */
export async function readWorktreeStartingBaseline(
	worktreePath: string,
	depsOrRunner?: GitRunner | IsBranchInHeadDeps,
): Promise<WorktreeStartingBaseline> {
	const { runner } = resolveGitRunner(depsOrRunner);
	const resolvedPath = nodePath.resolve(worktreePath);

	const headResult = await runner.run(['rev-parse', 'HEAD'], resolvedPath);
	if (headResult.exitCode !== 0 || !headResult.stdout.trim()) {
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			`Cannot read worktree HEAD: ${headResult.stderr}`,
		);
	}
	const headSha = headResult.stdout.trim();

	// 检查工作区是否有任何脏状态（已暂存、未暂存、untracked 文件）
	const statusResult = await runner.run(['status', '--porcelain', '-z', '-uall'], resolvedPath);
	if (statusResult.exitCode !== 0) {
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			`Cannot read worktree status: ${statusResult.stderr}`,
		);
	}
	if (!statusResult.stdout) {
		// 干净工作区：直接取 HEAD^{tree}
		const treeResult = await runner.run(['rev-parse', 'HEAD^{tree}'], resolvedPath);
		if (treeResult.exitCode !== 0 || !treeResult.stdout.trim()) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Cannot read clean worktree tree: ${treeResult.stderr}`,
			);
		}
		return Object.freeze({ headSha, treeSha: treeResult.stdout.trim() });
	}

	// 脏工作区：使用独立临时 index 冻结真实工作区状态为树对象（含修改与 untracked），不污染实际 index
	const tempIndexPath = nodePath.join(
		nodePath.resolve(nodeOs.tmpdir()),
		`agent-git-index-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		const readRes = await runner.run(['read-tree', headSha], resolvedPath, {
			envOverrides: { GIT_INDEX_FILE: tempIndexPath },
		});
		if (readRes.exitCode !== 0) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Cannot initialize worktree snapshot: ${readRes.stderr}`,
			);
		}
		const addRes = await runner.run(['add', '-A'], resolvedPath, {
			envOverrides: { GIT_INDEX_FILE: tempIndexPath },
		});
		if (addRes.exitCode !== 0) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Cannot stage worktree snapshot: ${addRes.stderr}`,
			);
		}
		const writeRes = await runner.run(['write-tree'], resolvedPath, {
			envOverrides: { GIT_INDEX_FILE: tempIndexPath },
		});
		if (writeRes.exitCode !== 0 || !writeRes.stdout.trim()) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Cannot freeze worktree snapshot: ${writeRes.stderr}`,
			);
		}
		return Object.freeze({ headSha, treeSha: writeRes.stdout.trim() });
	} finally {
		try {
			await nodeFs.unlink(tempIndexPath);
		} catch {
			// ignore cleanup error
		}
	}
}
