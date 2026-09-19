import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { AppError } from '../errors/app-error.ts';
import type {
	PlatformHostInputs,
	ResolvedExecutable,
	SupportedPlatform,
} from '../platform/contract.ts';
import { takePlatformHostInputs } from '../platform/host.ts';
import { resolveExecutable } from '../platform/resolve-executable.ts';
import { type LaunchSpec, spawnManaged } from '../proc/spawn.ts';

export interface GitCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface GitRunner {
	run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export interface WorktreeEntry {
	readonly path: string;
	readonly head: string;
	readonly branch: string | null;
	readonly isBare: boolean;
	readonly isLocked: boolean;
	readonly lockReason?: string;
	readonly isPrunable: boolean;
	readonly prunableReason?: string;
}

export interface GitRepoCheckResult {
	readonly isGitRepo: boolean;
	readonly repoRoot?: string;
	readonly requiresSerialExecution: boolean;
	readonly reason?: string;
}

export interface PrepareWorktreeInput {
	readonly repoPath: string;
	readonly taskId: string;
	readonly baseRef?: string;
	readonly branchPrefix?: string;
	readonly preferredBranchName?: string;
	readonly targetWorktreePath?: string;
	readonly worktreesDir?: string;
	readonly worktreeMode?: 'fresh' | 'reuse';
}

export interface PrepareWorktreeResult {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseRef: string;
	readonly isReused: boolean;
}

export interface CleanupWorktreeInput {
	readonly repoPath: string;
	readonly worktreePath: string;
	readonly force?: boolean;
	readonly deleteBranch?: boolean;
	readonly branchName?: string;
}

export interface CleanupWorktreeResult {
	readonly removed: true;
	readonly branchDeleted?: boolean;
}

export interface WorktreeInspectionResult {
	readonly hasChanges: boolean;
	readonly changedFileCount: number;
	readonly diff?: string;
}

export interface WorktreeInspector {
	inspect(worktreePath: string): Promise<WorktreeInspectionResult>;
}

export interface WorktreeFileSystem {
	readonly mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined>;
	readonly rm?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
	readonly stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
	readonly access?: (path: string) => Promise<void>;
}

export interface WorktreeManagerDeps {
	readonly platform: SupportedPlatform;
	readonly gitBinary?: string | ResolvedExecutable;
	readonly hostInputs?: PlatformHostInputs;
	readonly gitRunner?: GitRunner;
	readonly spawnManaged?: typeof spawnManaged;
	readonly clock?: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly fs?: WorktreeFileSystem;
	readonly homedir?: string;
}

export interface WorktreeManager extends WorktreeInspector {
	readonly platform: SupportedPlatform;
	checkGitRepository(repoPath: string): Promise<GitRepoCheckResult>;
	assertGitRepository(repoPath: string): Promise<GitRepoCheckResult>;
	listWorktrees(repoPath: string): Promise<readonly WorktreeEntry[]>;
	resolveBranchName(
		repoPath: string,
		taskId: string,
		options?: { branchPrefix?: string; preferredBranchName?: string },
	): Promise<string>;
	resolveWrapupBranchName(
		repoPath: string,
		batchId: string | number,
		round: number,
	): Promise<string>;
	prepareWorktree(input: PrepareWorktreeInput): Promise<PrepareWorktreeResult>;
	prepareWrapupWorktree(input: PrepareWrapupWorktreeInput): Promise<PrepareWrapupWorktreeResult>;
	removeWorktree(input: CleanupWorktreeInput): Promise<CleanupWorktreeResult>;
	inspect(worktreePath: string): Promise<WorktreeInspectionResult>;
}

export function parseWorktreeListPorcelain(text: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const blocks = text
		.split(/\r?\n\r?\n/)
		.map((b) => b.trim())
		.filter((b) => b.length > 0);

	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		let worktreePath = '';
		let head = '';
		let branch: string | null = null;
		let isBare = false;
		let isLocked = false;
		let lockReason: string | undefined = undefined;
		let isPrunable = false;
		let prunableReason: string | undefined = undefined;

		for (const line of lines) {
			if (line.startsWith('worktree ')) {
				worktreePath = line.slice('worktree '.length).trim();
			} else if (line.startsWith('HEAD ')) {
				head = line.slice('HEAD '.length).trim();
			} else if (line.startsWith('branch ')) {
				const rawBranch = line.slice('branch '.length).trim();
				branch = rawBranch.startsWith('refs/heads/')
					? rawBranch.slice('refs/heads/'.length)
					: rawBranch;
			} else if (line === 'bare') {
				isBare = true;
			} else if (line.startsWith('locked')) {
				isLocked = true;
				const reason = line.slice('locked'.length).trim();
				if (reason.length > 0) {
					lockReason = reason;
				}
			} else if (line.startsWith('prunable')) {
				isPrunable = true;
				const reason = line.slice('prunable'.length).trim();
				if (reason.length > 0) {
					prunableReason = reason;
				}
			} else if (line === 'detached') {
				branch = null;
			}
		}

		if (worktreePath.length > 0) {
			entries.push(
				Object.freeze({
					path: worktreePath,
					head,
					branch,
					isBare,
					isLocked,
					...(lockReason !== undefined ? { lockReason } : {}),
					isPrunable,
					...(prunableReason !== undefined ? { prunableReason } : {}),
				}),
			);
		}
	}

	return entries;
}

export async function resolveGitExecutable(
	deps: Pick<WorktreeManagerDeps, 'platform' | 'gitBinary' | 'hostInputs' | 'homedir'>,
): Promise<ResolvedExecutable> {
	if (typeof deps.gitBinary === 'object' && deps.gitBinary !== null) {
		return deps.gitBinary;
	}

	let hostInputs = deps.hostInputs;
	if (!hostInputs) {
		const hostResult = takePlatformHostInputs({});
		if (hostResult.ok) {
			hostInputs = {
				...hostResult.value,
				platform: deps.platform ?? hostResult.value.platform,
			};
		} else {
			hostInputs = {
				platform: deps.platform,
				homedir: deps.homedir ?? '',
			};
		}
	}

	const resolution = await resolveExecutable({
		hostInputs,
		executableName: 'git',
		configuredPath: typeof deps.gitBinary === 'string' ? deps.gitBinary : undefined,
	});

	if (!resolution.ok) {
		throw new AppError(resolution.error.code, resolution.error.message, {
			cause: resolution.error.cause,
			details: resolution.error.details as Record<string, unknown>,
		});
	}

	return resolution.executable;
}

export function createDefaultGitRunner(deps: WorktreeManagerDeps): GitRunner {
	let resolvedGit: ResolvedExecutable | undefined =
		typeof deps.gitBinary === 'object' && deps.gitBinary !== null ? deps.gitBinary : undefined;

	async function getOrResolveGit(): Promise<ResolvedExecutable> {
		if (resolvedGit) return resolvedGit;
		resolvedGit = await resolveGitExecutable(deps);
		return resolvedGit;
	}

	return {
		async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
			const git = await getOrResolveGit();
			const runId = `git_${deps.ids.newId()}`;
			const spec: LaunchSpec = {
				runId,
				file: git.file,
				args: [...git.argsPrefix, ...args],
				cwd,
			};

			const stdoutLines: string[] = [];
			const stderrLines: string[] = [];
			const spawnImpl = deps.spawnManaged ?? spawnManaged;

			return new Promise<GitCommandResult>((resolve, reject) => {
				try {
					const managed = spawnImpl(spec, {
						platform: deps.platform,
						onLine: (line) => stdoutLines.push(line.text),
						onStderr: (line) => stderrLines.push(line.text),
						onExit: (result) => {
							resolve({
								exitCode: result.exitCode ?? (result.signal ? 128 : 0),
								stdout: stdoutLines.join('\n'),
								stderr: stderrLines.join('\n'),
							});
						},
						onError: (err) => {
							reject(err);
						},
					});

					if (managed.isExited && managed.exitResult) {
						resolve({
							exitCode: managed.exitResult.exitCode ?? 0,
							stdout: stdoutLines.join('\n'),
							stderr: stderrLines.join('\n'),
						});
					}
				} catch (err) {
					reject(err);
				}
			});
		},
	};
}

export async function checkGitRepository(
	repoPath: string,
	runner: GitRunner,
): Promise<GitRepoCheckResult> {
	try {
		const result = await runner.run(
			['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
			repoPath,
		);

		if (result.exitCode !== 0 || !result.stdout.includes('true')) {
			return Object.freeze({
				isGitRepo: false,
				requiresSerialExecution: true,
				reason:
					'Target directory is not a git repository; parallel worktrees unavailable, forcing serial execution',
			});
		}

		const lines = result.stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		const repoRoot = lines.find((l) => l !== 'true') ?? repoPath;

		return Object.freeze({
			isGitRepo: true,
			repoRoot,
			requiresSerialExecution: false,
		});
	} catch (cause) {
		return Object.freeze({
			isGitRepo: false,
			requiresSerialExecution: true,
			reason: `Target directory is not a git repository (${cause instanceof Error ? cause.message : String(cause)}); parallel worktrees unavailable, forcing serial execution`,
		});
	}
}

export async function assertGitRepository(
	repoPath: string,
	runner: GitRunner,
): Promise<GitRepoCheckResult> {
	const check = await checkGitRepository(repoPath, runner);
	if (!check.isGitRepo) {
		throw new AppError(
			'E_NOT_A_GIT_REPO',
			'Target directory is not a git repository; parallel worktrees unavailable, forcing serial execution',
			{
				details: {
					repoPath,
					reason: 'not-a-git-repo',
					forcedSerial: true,
				},
			},
		);
	}
	return check;
}

export async function listWorktrees(
	repoPath: string,
	runner: GitRunner,
): Promise<readonly WorktreeEntry[]> {
	const result = await runner.run(['worktree', 'list', '--porcelain'], repoPath);
	if (result.exitCode !== 0) {
		throw new AppError(
			'E_INTERNAL',
			`Failed to list git worktrees: ${result.stderr || result.stdout}`,
			{ details: { repoPath, exitCode: result.exitCode, stderr: result.stderr } },
		);
	}
	return Object.freeze(parseWorktreeListPorcelain(result.stdout));
}

async function listAllBranchNames(repoPath: string, runner: GitRunner): Promise<Set<string>> {
	const branches = new Set<string>();

	const branchResult = await runner.run(
		['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
		repoPath,
	);
	if (branchResult.exitCode === 0) {
		for (const line of branchResult.stdout.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				branches.add(trimmed);
			}
		}
	}

	const worktrees = await listWorktrees(repoPath, runner).catch(() => []);
	for (const wt of worktrees) {
		if (wt.branch) {
			branches.add(wt.branch);
		}
	}

	return branches;
}

export async function resolveBranchName(
	repoPath: string,
	taskId: string,
	runner: GitRunner,
	options: {
		branchPrefix?: string;
		preferredBranchName?: string;
	} = {},
): Promise<string> {
	const prefix = options.branchPrefix ?? 'task/';
	const baseBranch = options.preferredBranchName ?? `${prefix}${taskId}`;

	const existingBranches = await listAllBranchNames(repoPath, runner);

	if (!existingBranches.has(baseBranch)) {
		return baseBranch;
	}

	// E-71: 分支名冲突: 自动加序号后缀（任务号-2），不复用、不强制覆盖已有分支
	let suffixIndex = 2;
	while (existingBranches.has(`${baseBranch}-${suffixIndex}`)) {
		suffixIndex++;
	}

	return `${baseBranch}-${suffixIndex}`;
}

function sanitizeDirectoryName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function resolveDefaultWorktreePath(
	repoPath: string,
	taskId: string,
	branchSuffix?: number,
	customDir?: string,
): string {
	const sanitizedTaskId = sanitizeDirectoryName(taskId).toLowerCase();
	const repoName = nodePath.basename(nodePath.resolve(repoPath));
	const suffix = branchSuffix !== undefined && branchSuffix >= 2 ? `-${branchSuffix}` : '';
	const dirName = `${repoName}-${sanitizedTaskId}${suffix}`;

	if (customDir !== undefined && customDir.length > 0) {
		return nodePath.resolve(customDir, dirName);
	}

	const parentDir = nodePath.dirname(nodePath.resolve(repoPath));
	return nodePath.resolve(parentDir, dirName);
}

function categorizeWorktreeCreationError(
	cause: unknown,
	repoPath: string,
	worktreePath: string,
	branchName: string,
): AppError {
	const message = cause instanceof Error ? cause.message : String(cause);
	const code = (cause as { code?: string })?.code;

	const isDiskFull =
		code === 'ENOSPC' || /no space left on device|disk full|enospc|not enough space/i.test(message);

	const isPermissionDenied =
		code === 'EACCES' ||
		code === 'EPERM' ||
		/permission denied|access is denied|eacces|eperm/i.test(message);

	const reason = isDiskFull
		? 'disk-full'
		: isPermissionDenied
			? 'permission-denied'
			: 'worktree-creation-failed';

	// E-76: 磁盘不足或权限问题时标「派发失败·工作区不可用」并释放窗口名额，不让整批卡死
	return new AppError('E_WORKSPACE_UNAVAILABLE', `Worktree creation failed: ${message}`, {
		cause,
		details: {
			repoPath,
			worktreePath,
			branchName,
			reason,
			releaseSlot: true,
			workspaceUnavailable: true,
		},
	});
}

export async function prepareWorktree(
	input: PrepareWorktreeInput,
	runner: GitRunner,
	deps: WorktreeManagerDeps,
): Promise<PrepareWorktreeResult> {
	const repoPath = nodePath.resolve(input.repoPath);
	const taskId = input.taskId.trim();
	if (taskId.length === 0) {
		throw new AppError('E_VALIDATION', 'taskId must not be empty', { details: { input } });
	}

	// 1. Assert git repository (AC 2, E-69)
	await assertGitRepository(repoPath, runner);

	const mode = input.worktreeMode ?? 'fresh';
	const existingWorktrees = await listWorktrees(repoPath, runner);

	// 2. If reuse mode requested (E-121 / E-277)
	if (mode === 'reuse') {
		const expectedPrefix = input.branchPrefix ?? 'task/';
		const targetBranch = input.preferredBranchName ?? `${expectedPrefix}${taskId}`;
		const matching = existingWorktrees.find(
			(wt) =>
				wt.branch === targetBranch ||
				(input.targetWorktreePath &&
					nodePath.resolve(wt.path) === nodePath.resolve(input.targetWorktreePath)),
		);
		const registeredDirectoryExists = matching
			? await worktreeDirectoryExists(matching.path, deps)
			: false;
		if (matching && !matching.isPrunable && registeredDirectoryExists) {
			return Object.freeze({
				worktreePath: matching.path,
				branchName: matching.branch ?? targetBranch,
				baseRef: input.baseRef ?? 'HEAD',
				isReused: true,
			});
		}

		// E-277：目录被删但登记还在（prunable），或登记也没了但分支仍在——都在原分支上重建，
		// 不 `-b` 新分支、不换 base。旧版 Git 对 prunable 登记执行 `worktree add --force` 可能成功退出却
		// 不重建目录，所以先精确 remove 这一条登记；绝不对全仓执行 worktree prune。
		const reuseBranch = matching?.branch ?? targetBranch;
		const branchExists =
			matching !== undefined || (await listAllBranchNames(repoPath, runner)).has(reuseBranch);
		if (branchExists) {
			const reusePath = matching
				? nodePath.resolve(matching.path)
				: input.targetWorktreePath
					? nodePath.resolve(input.targetWorktreePath)
					: resolveDefaultWorktreePath(repoPath, taskId, undefined, input.worktreesDir);
			if (matching) {
				const removeResult = await runner.run(
					['worktree', 'remove', '--force', matching.path],
					repoPath,
				);
				if (removeResult.exitCode !== 0) {
					throw categorizeWorktreeCreationError(
						new Error(removeResult.stderr || removeResult.stdout),
						repoPath,
						reusePath,
						reuseBranch,
					);
				}
			}
			const reuseArgs = ['worktree', 'add', reusePath, reuseBranch];
			let reuseResult: GitCommandResult;
			try {
				reuseResult = await runner.run(reuseArgs, repoPath);
			} catch (cause) {
				throw categorizeWorktreeCreationError(cause, repoPath, reusePath, reuseBranch);
			}
			if (reuseResult.exitCode !== 0) {
				throw categorizeWorktreeCreationError(
					new Error(reuseResult.stderr || reuseResult.stdout),
					repoPath,
					reusePath,
					reuseBranch,
				);
			}
			return Object.freeze({
				worktreePath: reusePath,
				branchName: reuseBranch,
				baseRef: input.baseRef ?? 'HEAD',
				isReused: true,
			});
		}
	}

	// 3. Resolve branch name with collision detection (AC 1, E-71)
	const branchName = await resolveBranchName(repoPath, taskId, runner, {
		branchPrefix: input.branchPrefix,
		preferredBranchName: input.preferredBranchName,
	});

	let branchSuffix: number | undefined = undefined;
	const suffixMatch = branchName.match(/-(\d+)$/);
	if (suffixMatch?.[1]) {
		branchSuffix = Number.parseInt(suffixMatch[1], 10);
	}

	// 4. Resolve unique worktree path
	let worktreePath = input.targetWorktreePath
		? nodePath.resolve(input.targetWorktreePath)
		: resolveDefaultWorktreePath(repoPath, taskId, branchSuffix, input.worktreesDir);

	const isPathOccupied = (p: string) =>
		existingWorktrees.some((wt) => nodePath.resolve(wt.path) === nodePath.resolve(p));

	if (isPathOccupied(worktreePath)) {
		let pathIndex = branchSuffix ?? 2;
		while (isPathOccupied(`${worktreePath}-${pathIndex}`)) {
			pathIndex++;
		}
		worktreePath = `${worktreePath}-${pathIndex}`;
	}

	const baseRef = input.baseRef ?? 'HEAD';

	// 5. Execute git worktree add (AC 1, AC 3, E-72)
	// Does NOT stash user changes or touch main worktree (E-72).
	const gitArgs = ['worktree', 'add', '-b', branchName, worktreePath, baseRef];

	let addResult: GitCommandResult;
	try {
		addResult = await runner.run(gitArgs, repoPath);
	} catch (cause) {
		throw categorizeWorktreeCreationError(cause, repoPath, worktreePath, branchName);
	}

	if (addResult.exitCode !== 0) {
		const error = new Error(addResult.stderr || addResult.stdout);
		throw categorizeWorktreeCreationError(error, repoPath, worktreePath, branchName);
	}

	return Object.freeze({
		worktreePath,
		branchName,
		baseRef,
		isReused: false,
	});
}

async function worktreeDirectoryExists(path: string, deps: WorktreeManagerDeps): Promise<boolean> {
	const stat = deps.fs?.stat ?? nodeFs.stat;
	try {
		return (await stat(path)).isDirectory();
	} catch (cause) {
		if ((cause as { code?: string })?.code === 'ENOENT') return false;
		throw categorizeWorktreeCreationError(cause, path, path, 'unknown');
	}
}

export async function removeWorktree(
	input: CleanupWorktreeInput,
	runner: GitRunner,
	deps: WorktreeManagerDeps,
): Promise<CleanupWorktreeResult> {
	const repoPath = nodePath.resolve(input.repoPath);
	const worktreePath = nodePath.resolve(input.worktreePath);
	const force = input.force ?? false;
	const deleteBranch = input.deleteBranch ?? false;

	const existingWorktrees = await listWorktrees(repoPath, runner).catch(() => []);
	const matching = existingWorktrees.find((wt) => nodePath.resolve(wt.path) === worktreePath);

	let branchDeleted = false;

	if (matching) {
		const removeArgs = ['worktree', 'remove'];
		if (force) {
			removeArgs.push('--force');
		}
		removeArgs.push(worktreePath);

		const result = await runner.run(removeArgs, repoPath);
		if (result.exitCode !== 0) {
			if (force && deps.fs?.rm) {
				await deps.fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
			} else if (force) {
				await nodeFs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
			} else {
				throw new AppError(
					'E_WORKSPACE_UNAVAILABLE',
					`Failed to remove worktree: ${result.stderr || result.stdout}`,
					{ details: { repoPath, worktreePath, stderr: result.stderr } },
				);
			}
		}
	} else {
		if (force) {
			if (deps.fs?.rm) {
				await deps.fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
			} else {
				await nodeFs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
			}
		}
	}

	await runner.run(['worktree', 'prune'], repoPath).catch(() => {});

	const branchToDelete = input.branchName ?? matching?.branch;
	if (deleteBranch && branchToDelete) {
		const branchResult = await runner.run(['branch', '-D', branchToDelete], repoPath);
		if (branchResult.exitCode === 0) {
			branchDeleted = true;
		}
	}

	return Object.freeze({
		removed: true,
		...(deleteBranch ? { branchDeleted } : {}),
	});
}

export async function inspectWorktree(
	worktreePath: string,
	runner: GitRunner,
): Promise<WorktreeInspectionResult> {
	const resolvedPath = nodePath.resolve(worktreePath);

	const statusResult = await runner.run(['status', '--porcelain'], resolvedPath);
	if (statusResult.exitCode !== 0) {
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			`Failed to inspect worktree status: ${statusResult.stderr || statusResult.stdout}`,
			{ details: { worktreePath: resolvedPath, exitCode: statusResult.exitCode } },
		);
	}

	const lines = statusResult.stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	const changedFileCount = lines.length;
	const hasChanges = changedFileCount > 0;

	const diffResult = await runner.run(['diff', 'HEAD'], resolvedPath).catch(() => ({
		exitCode: 0,
		stdout: '',
		stderr: '',
	}));

	return Object.freeze({
		hasChanges,
		changedFileCount,
		diff: diffResult.stdout,
	});
}

export interface PrepareWrapupWorktreeInput {
	readonly repoPath: string;
	readonly batchId: string | number;
	readonly round: number;
	readonly targetWorktreePath?: string;
	readonly worktreesDir?: string;
	readonly worktreeMode?: 'fresh' | 'reuse';
}

export interface PrepareWrapupWorktreeResult {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseRef: 'HEAD';
	readonly isReused: boolean;
}

export function formatWrapupBranchName(batchId: string | number, round: number): string {
	return `wrapup/${batchId}-${round}`;
}

export async function resolveWrapupBranchName(
	repoPath: string,
	batchId: string | number,
	round: number,
	runner: GitRunner,
): Promise<string> {
	const preferredBranchName = formatWrapupBranchName(batchId, round);
	return resolveBranchName(repoPath, `${batchId}-${round}`, runner, {
		preferredBranchName,
	});
}

export async function prepareWrapupWorktree(
	input: PrepareWrapupWorktreeInput,
	runner: GitRunner,
	deps: WorktreeManagerDeps,
): Promise<PrepareWrapupWorktreeResult> {
	const preferredBranchName = await resolveWrapupBranchName(
		input.repoPath,
		input.batchId,
		input.round,
		runner,
	);

	const result = await prepareWorktree(
		{
			repoPath: input.repoPath,
			taskId: `wrapup-${input.batchId}-${input.round}`,
			baseRef: 'HEAD',
			preferredBranchName,
			targetWorktreePath: input.targetWorktreePath,
			worktreesDir: input.worktreesDir,
			worktreeMode: input.worktreeMode,
		},
		runner,
		deps,
	);

	return Object.freeze({
		worktreePath: result.worktreePath,
		branchName: result.branchName,
		baseRef: 'HEAD',
		isReused: result.isReused,
	});
}

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
	const runner = deps.gitRunner ?? createDefaultGitRunner(deps);

	return Object.freeze({
		platform: deps.platform,
		checkGitRepository(repoPath: string) {
			return checkGitRepository(repoPath, runner);
		},
		assertGitRepository(repoPath: string) {
			return assertGitRepository(repoPath, runner);
		},
		listWorktrees(repoPath: string) {
			return listWorktrees(repoPath, runner);
		},
		resolveBranchName(
			repoPath: string,
			taskId: string,
			options?: { branchPrefix?: string; preferredBranchName?: string },
		) {
			return resolveBranchName(repoPath, taskId, runner, options);
		},
		resolveWrapupBranchName(repoPath: string, batchId: string | number, round: number) {
			return resolveWrapupBranchName(repoPath, batchId, round, runner);
		},
		prepareWorktree(input: PrepareWorktreeInput) {
			return prepareWorktree(input, runner, deps);
		},
		prepareWrapupWorktree(input: PrepareWrapupWorktreeInput) {
			return prepareWrapupWorktree(input, runner, deps);
		},
		removeWorktree(input: CleanupWorktreeInput) {
			return removeWorktree(input, runner, deps);
		},
		inspect(worktreePath: string) {
			return inspectWorktree(worktreePath, runner);
		},
	});
}
