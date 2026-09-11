import { promises as nodeFs } from 'node:fs';
import { join as nodeJoin, resolve as nodeResolve } from 'node:path';
import { AppError } from '../errors/app-error.ts';
import { takePlatformHostInputs } from '../platform/host.ts';
import { type GitCommandResult, type GitRunner, createDefaultGitRunner } from './worktree.ts';

export type { GitCommandResult, GitRunner };

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface DiffFileStat {
	readonly path: string;
	readonly insertions: number;
	readonly deletions: number;
	readonly status: DiffFileStatus;
	readonly oldPath?: string;
	readonly binary?: boolean;
}

export interface DiffOptions {
	/**
	 * Path to the task's worktree directory.
	 */
	readonly worktreePath: string;

	/**
	 * Diff baseline ref (defaults to 'HEAD' representing the worktree's own HEAD, E-72).
	 */
	readonly baseRef?: string;

	/**
	 * Whether to include untracked files in the diff stats and patch text.
	 * Defaults to true.
	 */
	readonly includeUntracked?: boolean;

	/**
	 * Optional GitRunner to execute git operations.
	 */
	readonly runner?: GitRunner;

	/**
	 * Whether to check if commits on this branch were pushed to a remote (E-75).
	 * Defaults to false.
	 */
	readonly detectRemotePush?: boolean;
}

export interface DiffStatResult {
	readonly filesChanged: number;
	readonly changedFileCount: number;
	readonly insertions: number;
	readonly deletions: number;
	readonly hasChanges: boolean;
	readonly baseline: string;
	readonly files: readonly DiffFileStat[];
	readonly remotePush?: RemotePushDetectionResult;
}

export interface DetectRemotePushOptions {
	readonly worktreePath: string;
	readonly runner?: GitRunner;
	readonly branchName?: string;
	readonly baseRef?: string;
}

export interface RemotePushDetectionResult {
	readonly pushed: boolean;
	readonly branch?: string;
	readonly commit?: string;
	readonly remote?: string;
	readonly remoteRef?: string;
	readonly details?: string;
}

export interface WorktreeDiffInspection {
	readonly diffStat: DiffStatResult;
	readonly diffText: string;
	readonly remotePush: RemotePushDetectionResult;
	readonly hasChanges: boolean;
	readonly changedFileCount: number;
}

function normalizeDiffOptions(
	worktreePathOrOptions: string | DiffOptions,
	maybeOptions?: Omit<DiffOptions, 'worktreePath'>,
): DiffOptions {
	if (typeof worktreePathOrOptions === 'string') {
		return {
			worktreePath: worktreePathOrOptions,
			...maybeOptions,
		};
	}
	return worktreePathOrOptions;
}

function getDefaultRunner(): GitRunner {
	const hostResult = takePlatformHostInputs({});
	const hostInputs = hostResult.ok ? hostResult.value : { platform: 'linux' as const, homedir: '' };
	return createDefaultGitRunner({
		platform: hostInputs.platform,
		hostInputs,
		ids: { newId: () => Math.random().toString(36).slice(2, 10) },
	});
}

async function assertWorktreeDirectory(resolvedPath: string): Promise<void> {
	try {
		const stat = await nodeFs.stat(resolvedPath);
		if (!stat.isDirectory()) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Worktree path is not a directory: ${resolvedPath}`,
				{ details: { worktreePath: resolvedPath } },
			);
		}
	} catch (cause) {
		if (cause instanceof AppError) throw cause;
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			`Worktree path is inaccessible: ${resolvedPath}`,
			{ cause, details: { worktreePath: resolvedPath } },
		);
	}
}

function checkGitCommandError(
	result: GitCommandResult,
	worktreePath: string,
	context: string,
): void {
	if (result.exitCode !== 0) {
		const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
		if (
			combined.includes('not a git repository') ||
			combined.includes('fatal: not a git repository')
		) {
			throw new AppError(
				'E_NOT_A_GIT_REPO',
				`Target directory is not a git repository: ${worktreePath}`,
				{
					details: {
						worktreePath,
						context,
						exitCode: result.exitCode,
						stderr: result.stderr,
					},
				},
			);
		}
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			`Git command failed during ${context}: ${result.stderr || result.stdout}`,
			{
				details: {
					worktreePath,
					context,
					exitCode: result.exitCode,
					stderr: result.stderr,
				},
			},
		);
	}
}

export function isBinaryBuffer(buffer: Uint8Array): boolean {
	const len = Math.min(buffer.length, 8000);
	for (let i = 0; i < len; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

export function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	let stripped = text;
	if (stripped.endsWith('\r\n')) {
		stripped = stripped.slice(0, -2);
	} else if (stripped.endsWith('\n')) {
		stripped = stripped.slice(0, -1);
	}
	if (stripped.length === 0) return 0;
	return stripped.split(/\r?\n/).length;
}

export function parsePorcelainStatus(
	porcelainOutput: string,
): Array<{ path: string; status: DiffFileStatus; oldPath?: string }> {
	const results: Array<{
		path: string;
		status: DiffFileStatus;
		oldPath?: string;
	}> = [];
	if (!porcelainOutput || porcelainOutput.length === 0) return results;

	if (porcelainOutput.includes('\0')) {
		const tokens = porcelainOutput.split('\0');
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!token || token.length < 3) continue;
			const code = token.slice(0, 2);
			const filePath = token.slice(3);

			let status: DiffFileStatus = 'modified';
			if (code === '??') {
				status = 'untracked';
			} else if (code.includes('A')) {
				status = 'added';
			} else if (code.includes('D')) {
				status = 'deleted';
			} else if (code.includes('R')) {
				status = 'renamed';
				const oldPath = tokens[++i];
				results.push({ path: filePath, status, oldPath });
				continue;
			}
			results.push({ path: filePath, status });
		}
		return results;
	}

	const lines = porcelainOutput
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.length >= 3);

	for (const line of lines) {
		const code = line.slice(0, 2);
		const rest = line.slice(3).trim();

		let status: DiffFileStatus = 'modified';
		let filePath = rest;
		let oldPath: string | undefined = undefined;

		if (code === '??') {
			status = 'untracked';
		} else if (code.includes('A')) {
			status = 'added';
		} else if (code.includes('D')) {
			status = 'deleted';
		} else if (code.includes('R')) {
			status = 'renamed';
			if (rest.includes(' -> ')) {
				const parts = rest.split(' -> ');
				oldPath = parts[0]?.replace(/^"|"$/g, '');
				filePath = parts[1]?.replace(/^"|"$/g, '') ?? rest;
			}
		}

		filePath = filePath.replace(/^"|"$/g, '');
		results.push({ path: filePath, status, oldPath });
	}

	return results;
}

export function parseNumstat(
	numstatOutput: string,
): Map<string, { insertions: number; deletions: number; binary: boolean; oldPath?: string }> {
	const map = new Map<
		string,
		{ insertions: number; deletions: number; binary: boolean; oldPath?: string }
	>();
	if (!numstatOutput || numstatOutput.length === 0) return map;

	if (numstatOutput.includes('\0')) {
		const tokens = numstatOutput.split('\0');
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!token || token.length === 0) continue;
			const parts = token.split('\t');
			if (parts.length >= 3) {
				const insStr = parts[0] ?? '0';
				const delStr = parts[1] ?? '0';
				const isBinary = insStr === '-' && delStr === '-';
				const insertions = isBinary ? 0 : Number.parseInt(insStr, 10) || 0;
				const deletions = isBinary ? 0 : Number.parseInt(delStr, 10) || 0;

				if (parts.length === 3 && parts[2] === '') {
					// Rename in -z mode: \0old\0new
					const oldPath = tokens[++i];
					const newPath = tokens[++i];
					if (newPath) {
						map.set(newPath, {
							insertions,
							deletions,
							binary: isBinary,
							oldPath,
						});
					}
				} else {
					const filePath = parts.slice(2).join('\t');
					map.set(filePath, { insertions, deletions, binary: isBinary });
				}
			}
		}
		return map;
	}

	const lines = numstatOutput
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	for (const line of lines) {
		const parts = line.split('\t');
		if (parts.length >= 3) {
			const insStr = parts[0] ?? '0';
			const delStr = parts[1] ?? '0';
			const isBinary = insStr === '-' && delStr === '-';
			const insertions = isBinary ? 0 : Number.parseInt(insStr, 10) || 0;
			const deletions = isBinary ? 0 : Number.parseInt(delStr, 10) || 0;
			const filePath = parts.slice(2).join('\t');

			let cleanPath = filePath;
			let oldPath: string | undefined = undefined;

			// Handle rename syntax e.g. "{old => new}/file" or "old => new"
			if (filePath.includes(' => ')) {
				const match = filePath.match(/^(.*?)\{(.*?) => (.*?)\}(.*)$/);
				if (match) {
					const prefix = match[1] ?? '';
					const oldPart = match[2] ?? '';
					const newPart = match[3] ?? '';
					const suffix = match[4] ?? '';
					oldPath = `${prefix}${oldPart}${suffix}`;
					cleanPath = `${prefix}${newPart}${suffix}`;
				} else {
					const arrowParts = filePath.split(' => ');
					oldPath = arrowParts[0]?.trim();
					cleanPath = arrowParts[1]?.trim() ?? filePath;
				}
			}

			map.set(cleanPath, {
				insertions,
				deletions,
				binary: isBinary,
				oldPath,
			});
		}
	}

	return map;
}

export function parseNameStatus(
	nameStatusOutput: string,
): Map<string, { status: DiffFileStatus; oldPath?: string }> {
	const map = new Map<string, { status: DiffFileStatus; oldPath?: string }>();
	if (!nameStatusOutput || nameStatusOutput.length === 0) return map;

	if (nameStatusOutput.includes('\0')) {
		const tokens = nameStatusOutput.split('\0');
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!token || token.length === 0) continue;
			const statusCode = token[0];
			if (statusCode === 'R' || statusCode === 'C') {
				const oldPath = tokens[++i];
				const newPath = tokens[++i];
				if (newPath) {
					map.set(newPath, { status: 'renamed', oldPath });
				}
			} else {
				const filePath = tokens[++i];
				if (filePath) {
					let status: DiffFileStatus = 'modified';
					if (statusCode === 'A') status = 'added';
					else if (statusCode === 'D') status = 'deleted';
					map.set(filePath, { status });
				}
			}
		}
		return map;
	}

	const lines = nameStatusOutput
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	for (const line of lines) {
		const parts = line.split('\t');
		if (parts.length >= 2) {
			const statusCode = (parts[0] ?? 'M')[0];
			if ((statusCode === 'R' || statusCode === 'C') && parts.length >= 3) {
				const oldPath = parts[1];
				const newPath = parts[2];
				if (newPath) {
					map.set(newPath, { status: 'renamed', oldPath });
				}
			} else {
				const filePath = parts[1];
				if (filePath) {
					let status: DiffFileStatus = 'modified';
					if (statusCode === 'A') status = 'added';
					else if (statusCode === 'D') status = 'deleted';
					map.set(filePath, { status });
				}
			}
		}
	}

	return map;
}

export function formatUntrackedPatch(filePath: string, content: string, isBinary: boolean): string {
	const normalizedPath = filePath.replace(/\\/g, '/');
	if (isBinary) {
		return `diff --git a/${normalizedPath} b/${normalizedPath}\nnew file mode 100644\nBinary files /dev/null and b/${normalizedPath} differ\n`;
	}

	const lineCount = countTextLines(content);
	if (lineCount === 0) {
		return `diff --git a/${normalizedPath} b/${normalizedPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${normalizedPath}\n`;
	}

	let stripped = content;
	if (stripped.endsWith('\r\n')) {
		stripped = stripped.slice(0, -2);
	} else if (stripped.endsWith('\n')) {
		stripped = stripped.slice(0, -1);
	}
	const lines = stripped.split(/\r?\n/);

	const header = `diff --git a/${normalizedPath} b/${normalizedPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${normalizedPath}\n@@ -0,0 +1,${lines.length} @@\n`;
	const body = lines.map((l) => `+${l}`).join('\n');
	return `${header}${body}\n`;
}

/**
 * Reads diff stat (files changed, insertions, deletions) for a task worktree.
 * Diff baseline defaults to worktree's own HEAD (E-72).
 * Works uniformly across all agent types without parsing tool calls (AC 1).
 */
export async function getDiffStat(
	worktreePathOrOptions: string | DiffOptions,
	maybeOptions?: Omit<DiffOptions, 'worktreePath'>,
): Promise<DiffStatResult> {
	const options = normalizeDiffOptions(worktreePathOrOptions, maybeOptions);
	const resolvedPath = nodeResolve(options.worktreePath);
	const baseRef = options.baseRef ?? 'HEAD';
	const includeUntracked = options.includeUntracked ?? true;
	const runner = options.runner ?? getDefaultRunner();

	await assertWorktreeDirectory(resolvedPath);

	// 1. Check git repository status in worktree (E-72: isolated to worktreePath)
	const checkRepoResult = await runner.run(['rev-parse', '--is-inside-work-tree'], resolvedPath);
	checkGitCommandError(checkRepoResult, resolvedPath, 'repo check');

	// 2. Read git status for untracked and modified files
	const statusResult = await runner.run(['status', '--porcelain', '-z', '-uall'], resolvedPath);
	checkGitCommandError(statusResult, resolvedPath, 'status check');

	const statusEntries = parsePorcelainStatus(statusResult.stdout);
	const untrackedEntries = statusEntries.filter((e) => e.status === 'untracked');

	// 3. Run git diff --numstat against baseRef (defaults to worktree HEAD)
	const numstatResult = await runner.run(['diff', '--numstat', '-z', baseRef], resolvedPath);
	checkGitCommandError(numstatResult, resolvedPath, `diff --numstat ${baseRef}`);
	const numstatMap = parseNumstat(numstatResult.stdout);

	// 4. Run git diff --name-status against baseRef
	const nameStatusResult = await runner.run(['diff', '--name-status', '-z', baseRef], resolvedPath);
	checkGitCommandError(nameStatusResult, resolvedPath, `diff --name-status ${baseRef}`);
	const nameStatusMap = parseNameStatus(nameStatusResult.stdout);

	// 5. Aggregate tracked changes
	const fileStats: DiffFileStat[] = [];
	const seenPaths = new Set<string>();

	for (const [filePath, numstat] of numstatMap.entries()) {
		seenPaths.add(filePath);
		const nameStatus = nameStatusMap.get(filePath);
		const status = nameStatus?.status ?? 'modified';
		const oldPath = numstat.oldPath ?? nameStatus?.oldPath;

		fileStats.push(
			Object.freeze({
				path: filePath,
				insertions: numstat.insertions,
				deletions: numstat.deletions,
				status,
				...(oldPath ? { oldPath } : {}),
				...(numstat.binary ? { binary: true } : {}),
			}),
		);
	}

	// 6. Include untracked files (if enabled)
	if (includeUntracked) {
		for (const untracked of untrackedEntries) {
			if (seenPaths.has(untracked.path)) continue;
			seenPaths.add(untracked.path);

			const absoluteFilePath = nodeJoin(resolvedPath, untracked.path);
			let insertions = 0;
			let isBinary = false;

			try {
				const fileBuffer = await nodeFs.readFile(absoluteFilePath);
				isBinary = isBinaryBuffer(fileBuffer);
				if (!isBinary) {
					const text = new TextDecoder('utf-8').decode(fileBuffer);
					insertions = countTextLines(text);
				}
			} catch {
				// If file is unreadable or deleted, insertions = 0
			}

			fileStats.push(
				Object.freeze({
					path: untracked.path,
					insertions,
					deletions: 0,
					status: 'untracked',
					...(isBinary ? { binary: true } : {}),
				}),
			);
		}
	}

	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const f of fileStats) {
		totalInsertions += f.insertions;
		totalDeletions += f.deletions;
	}

	const filesChanged = fileStats.length;
	const hasChanges = filesChanged > 0;

	let remotePush: RemotePushDetectionResult | undefined = undefined;
	if (options.detectRemotePush) {
		remotePush = await detectRemotePush(resolvedPath, {
			runner,
			baseRef,
		});
	}

	return Object.freeze({
		filesChanged,
		changedFileCount: filesChanged,
		insertions: totalInsertions,
		deletions: totalDeletions,
		hasChanges,
		baseline: baseRef,
		files: Object.freeze(fileStats),
		...(remotePush ? { remotePush } : {}),
	});
}

/**
 * Reads git unified diff patch text for a task worktree.
 * Diff baseline defaults to worktree's own HEAD (E-72).
 * Formats untracked files into git-compatible unified diff patches (AC 1).
 */
export async function getDiffText(
	worktreePathOrOptions: string | DiffOptions,
	maybeOptions?: Omit<DiffOptions, 'worktreePath'>,
): Promise<string> {
	const options = normalizeDiffOptions(worktreePathOrOptions, maybeOptions);
	const resolvedPath = nodeResolve(options.worktreePath);
	const baseRef = options.baseRef ?? 'HEAD';
	const includeUntracked = options.includeUntracked ?? true;
	const runner = options.runner ?? getDefaultRunner();

	await assertWorktreeDirectory(resolvedPath);

	// 1. Run git diff against baseline
	const diffResult = await runner.run(['diff', baseRef], resolvedPath);
	checkGitCommandError(diffResult, resolvedPath, `diff ${baseRef}`);

	let combinedDiff = diffResult.stdout;

	// 2. If untracked files are included, append patches for each untracked file
	if (includeUntracked) {
		const statusResult = await runner.run(['status', '--porcelain', '-z', '-uall'], resolvedPath);
		if (statusResult.exitCode === 0) {
			const entries = parsePorcelainStatus(statusResult.stdout);
			const untracked = entries.filter((e) => e.status === 'untracked');

			for (const file of untracked) {
				const noIndexResult = await runner.run(
					['diff', '--no-index', '--', '/dev/null', file.path],
					resolvedPath,
				);

				if (
					(noIndexResult.exitCode === 0 || noIndexResult.exitCode === 1) &&
					noIndexResult.stdout.trim().length > 0
				) {
					if (combinedDiff.length > 0 && !combinedDiff.endsWith('\n')) {
						combinedDiff += '\n';
					}
					combinedDiff += noIndexResult.stdout;
				} else {
					// Fallback: read file and format standard git patch
					try {
						const absPath = nodeJoin(resolvedPath, file.path);
						const buf = await nodeFs.readFile(absPath);
						const isBinary = isBinaryBuffer(buf);
						const content = isBinary ? '' : new TextDecoder('utf-8').decode(buf);
						const patch = formatUntrackedPatch(file.path, content, isBinary);
						if (combinedDiff.length > 0 && !combinedDiff.endsWith('\n')) {
							combinedDiff += '\n';
						}
						combinedDiff += patch;
					} catch {
						// File inaccessible or removed
					}
				}
			}
		}
	}

	return combinedDiff;
}

/**
 * Detects if the agent in the worktree has pushed commits or branches to a remote repository (E-75, AC 3).
 * Does not block commits or pushes, but detects them for UI highlighting.
 */
export async function detectRemotePush(
	worktreePathOrOptions: string | DetectRemotePushOptions,
	maybeOptions?: Omit<DetectRemotePushOptions, 'worktreePath'>,
): Promise<RemotePushDetectionResult> {
	const options =
		typeof worktreePathOrOptions === 'string'
			? { worktreePath: worktreePathOrOptions, ...maybeOptions }
			: worktreePathOrOptions;

	const resolvedPath = nodeResolve(options.worktreePath);
	const runner = options.runner ?? getDefaultRunner();

	await assertWorktreeDirectory(resolvedPath);

	// 1. Get current branch name
	let currentBranch = options.branchName;
	if (!currentBranch) {
		const branchResult = await runner.run(['rev-parse', '--abbrev-ref', 'HEAD'], resolvedPath);
		if (branchResult.exitCode === 0) {
			const rawBranch = branchResult.stdout.trim();
			if (rawBranch.length > 0 && rawBranch !== 'HEAD') {
				currentBranch = rawBranch;
			}
		}
	}

	// 2. Get current HEAD commit
	const headResult = await runner.run(['rev-parse', 'HEAD'], resolvedPath);
	const currentHead = headResult.exitCode === 0 ? headResult.stdout.trim() : '';

	// 3. Query all remote references
	const forEachRefResult = await runner.run(
		['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'],
		resolvedPath,
	);

	if (forEachRefResult.exitCode !== 0 || !forEachRefResult.stdout) {
		return Object.freeze({ pushed: false });
	}

	const lines = forEachRefResult.stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	// 4. Check if current task branch matches any remote ref (e.g. refs/remotes/origin/task/M5-T3)
	if (currentBranch) {
		const targetSuffix = `/${currentBranch}`;
		for (const line of lines) {
			const spaceIdx = line.indexOf(' ');
			if (spaceIdx === -1) continue;
			const refname = line.slice(0, spaceIdx);
			const objectname = line.slice(spaceIdx + 1);

			if (refname.endsWith(targetSuffix)) {
				// Extract remote name (refs/remotes/<remote>/<branch>)
				const withoutPrefix = refname.slice('refs/remotes/'.length);
				const slashIdx = withoutPrefix.indexOf('/');
				const remote = slashIdx !== -1 ? withoutPrefix.slice(0, slashIdx) : 'origin';

				return Object.freeze({
					pushed: true,
					branch: currentBranch,
					commit: objectname,
					remote,
					remoteRef: refname,
					details: `Branch '${currentBranch}' was pushed to remote '${remote}' at commit ${objectname}`,
				});
			}
		}
	}

	// 5. Check if current HEAD is contained in any remote branch
	// (e.g. agent pushed HEAD to a different branch name)
	if (currentHead && currentHead.length > 0) {
		let baseSha = '';
		if (options.baseRef) {
			const baseResult = await runner.run(['rev-parse', options.baseRef], resolvedPath);
			if (baseResult.exitCode === 0) {
				baseSha = baseResult.stdout.trim();
			}
		}

		// Only check commit containment if HEAD has progressed beyond baseSha
		if (!baseSha || currentHead !== baseSha) {
			const containsResult = await runner.run(['branch', '-r', '--contains', 'HEAD'], resolvedPath);

			if (containsResult.exitCode === 0 && containsResult.stdout.trim()) {
				const remoteBranches = containsResult.stdout
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter((l) => l.length > 0 && !l.includes('->'));

				for (const rb of remoteBranches) {
					const slashIdx = rb.indexOf('/');
					const remote = slashIdx !== -1 ? rb.slice(0, slashIdx) : 'origin';
					const branch = slashIdx !== -1 ? rb.slice(slashIdx + 1) : rb;

					// If baseRef is e.g. main, skip origin/main if currentHead is just the base
					if (options.baseRef && rb.endsWith(`/${options.baseRef}`)) {
						continue;
					}

					return Object.freeze({
						pushed: true,
						branch,
						commit: currentHead,
						remote,
						remoteRef: `refs/remotes/${rb}`,
						details: `Commit ${currentHead} was pushed to remote branch '${rb}'`,
					});
				}
			}
		}
	}

	return Object.freeze({ pushed: false });
}

/**
 * Inspects both diff stat, unified diff text, and remote push status for a worktree.
 */
export async function inspectWorktreeDiff(
	worktreePath: string,
	options?: Omit<DiffOptions, 'worktreePath'>,
): Promise<WorktreeDiffInspection> {
	const diffStat = await getDiffStat(worktreePath, options);
	const diffText = await getDiffText(worktreePath, options);
	const remotePush =
		diffStat.remotePush ??
		(await detectRemotePush(worktreePath, {
			runner: options?.runner,
			baseRef: options?.baseRef,
		}));

	return Object.freeze({
		diffStat,
		diffText,
		remotePush,
		hasChanges: diffStat.hasChanges,
		changedFileCount: diffStat.filesChanged,
	});
}
