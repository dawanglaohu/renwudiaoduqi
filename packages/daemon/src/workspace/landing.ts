import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type {
	CleanupTaskWorktreeResponse,
	GetTaskLandingResponse,
} from '@agent-scheduler/shared/api/tasks';
import type { DatabaseConnection } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';
import type { PlatformHostInputs, SupportedPlatform } from '../platform/contract.ts';
import { takePlatformHostInputs } from '../platform/host.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../repo/documents.ts';
import { type TaskRow, type TasksRepo, createTasksRepo } from '../repo/tasks.ts';
import { type DiffStatResult, getDiffStat } from './diff.ts';
import {
	type CleanupWorktreeInput,
	type GitRunner,
	type WorktreeEntry,
	type WorktreeFileSystem,
	type WorktreeManagerDeps,
	createDefaultGitRunner,
	listWorktrees,
	removeWorktree,
} from './worktree.ts';

export interface GenerateLandingCommandsOptions {
	readonly docsPath: string;
	readonly taskId: string;
	readonly ghStackCommand?: string;
}

export interface GetTaskLandingInput {
	readonly taskId: string;
	readonly taskKey?: string;
	readonly worktreePath?: string;
	readonly branchName?: string;
	readonly repoPath?: string;
	readonly docsPath?: string;
	readonly baseRef?: string;
	readonly ghStackCommand?: string;
	readonly allowMissingWorktree?: boolean;
}

export interface CleanupTaskWorktreeInput {
	readonly taskId: string;
	readonly taskKey?: string;
	readonly repoPath?: string;
	readonly worktreePath?: string;
	readonly branchName?: string;
	readonly force?: boolean;
	readonly deleteBranch?: boolean;
}

export interface TaskLandingServiceDeps {
	readonly runner?: GitRunner;
	readonly worktreeDeps?: WorktreeManagerDeps;
	readonly tasksRepo?: TasksRepo;
	readonly documentsRepo?: DocumentsRepo;
	readonly db?: DatabaseConnection;
	readonly platform?: SupportedPlatform;
	readonly hostInputs?: PlatformHostInputs;
	readonly ids?: { readonly newId: () => string };
	readonly fs?: WorktreeFileSystem;
	readonly repoPath?: string;
	readonly docsPath?: string;
	readonly defaultBranchPrefix?: string;
}

export interface TaskLandingService {
	getLanding(input: GetTaskLandingInput): Promise<GetTaskLandingResponse>;
	cleanupWorktree(input: CleanupTaskWorktreeInput): Promise<CleanupTaskWorktreeResponse>;
	generateLandingCommands(options: GenerateLandingCommandsOptions): readonly string[];
}

function sanitizeDirectoryName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function resolveDefaultWorktreePath(
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

/**
 * Normalizes document path to forward slashes for cross-platform python CLI commands.
 */
function normalizeDocsPath(docsPath: string): string {
	return docsPath.replace(/\\/g, '/');
}

/**
 * Generates copyable command texts for the landing checklist (AC 1, E-74, Decision 68).
 * Product only generates these strings for user copy; it never executes them.
 */
export function generateLandingCommands(
	options: GenerateLandingCommandsOptions,
): readonly string[] {
	const docsPath = normalizeDocsPath(options.docsPath.trim());
	const taskId = options.taskId.trim();
	const ghStackCmd = options.ghStackCommand?.trim() || 'gh stack push';
	const buildDocsCmd = `python ${docsPath}/_run/build_docs.py ${docsPath} --landed ${taskId}`;

	return Object.freeze([ghStackCmd, buildDocsCmd]);
}

function resolveTaskMetadata(
	cleanTaskId: string,
	tasksRepo?: TasksRepo,
	documentsRepo?: DocumentsRepo,
): {
	taskRow: TaskRow | null;
	taskKey: string;
	docsPath?: string;
	repoPath?: string;
	branchPrefix?: string;
} {
	if (!tasksRepo) {
		return { taskRow: null, taskKey: cleanTaskId };
	}

	// 1. Direct lookup by ID
	let taskRow = tasksRepo.findById(cleanTaskId);

	// 2. Lookup across known documents by docId + taskKey
	if (!taskRow && documentsRepo) {
		const allDocs = documentsRepo.listAll();
		for (const doc of allDocs) {
			const found = tasksRepo.findByDocAndKey(doc.id, cleanTaskId);
			if (found) {
				taskRow = found;
				break;
			}
		}
	}

	if (!taskRow) {
		return { taskRow: null, taskKey: cleanTaskId };
	}

	let docsPath: string | undefined;
	let repoPath: string | undefined;
	let branchPrefix: string | undefined;

	if (documentsRepo && taskRow.doc_id) {
		const doc = documentsRepo.findById(taskRow.doc_id);
		if (doc) {
			docsPath = doc.docs_path;
			repoPath = doc.repo_path ?? undefined;
			branchPrefix = doc.branch_prefix;
		}
	}

	return {
		taskRow,
		taskKey: taskRow.task_key,
		docsPath,
		repoPath,
		branchPrefix,
	};
}

async function findMatchingWorktree(
	repoPath: string,
	taskKey: string,
	taskId: string,
	runner: GitRunner,
): Promise<WorktreeEntry | null> {
	try {
		const worktrees = await listWorktrees(repoPath, runner);
		const sanitizedTaskKey = sanitizeDirectoryName(taskKey).toLowerCase();
		const sanitizedTaskId = sanitizeDirectoryName(taskId).toLowerCase();

		// Match 1: Branch matches taskKey or taskId
		for (const wt of worktrees) {
			if (wt.branch) {
				const cleanBranch = wt.branch.replace(/^refs\/heads\//, '');
				if (
					cleanBranch === `task/${taskKey}` ||
					cleanBranch === `task/${taskId}` ||
					cleanBranch.startsWith(`task/${taskKey}-`) ||
					cleanBranch.startsWith(`task/${taskId}-`)
				) {
					return wt;
				}
			}
		}

		// Match 2: Directory name matches sanitized taskKey or taskId
		for (const wt of worktrees) {
			const dirName = nodePath.basename(nodePath.resolve(wt.path)).toLowerCase();
			if (dirName.endsWith(`-${sanitizedTaskKey}`) || dirName.endsWith(`-${sanitizedTaskId}`)) {
				return wt;
			}
		}

		return null;
	} catch {
		return null;
	}
}

async function checkDirectoryExists(targetPath: string, fs?: WorktreeFileSystem): Promise<boolean> {
	try {
		if (fs?.stat) {
			const s = await fs.stat(targetPath);
			return s.isDirectory();
		}
		const s = await nodeFs.stat(targetPath);
		return s.isDirectory();
	} catch {
		return false;
	}
}

function resolveRunnerAndDeps(deps?: TaskLandingServiceDeps): {
	runner: GitRunner;
	worktreeDeps: WorktreeManagerDeps;
	tasksRepo?: TasksRepo;
	documentsRepo?: DocumentsRepo;
} {
	const defaultHostResult = takePlatformHostInputs({});
	const defaultHostInputs = defaultHostResult.ok ? defaultHostResult.value : undefined;

	const hostInputs = deps?.hostInputs ?? deps?.worktreeDeps?.hostInputs ?? defaultHostInputs;
	const platform =
		deps?.platform ?? deps?.worktreeDeps?.platform ?? hostInputs?.platform ?? 'linux';
	const ids = deps?.ids ?? deps?.worktreeDeps?.ids ?? { newId: () => 'landing-run-id' };

	const worktreeDeps: WorktreeManagerDeps = deps?.worktreeDeps ?? {
		platform,
		hostInputs,
		ids,
		fs: deps?.fs,
		gitRunner: deps?.runner,
	};

	const runner = deps?.runner ?? worktreeDeps.gitRunner ?? createDefaultGitRunner(worktreeDeps);

	const db = deps?.db;
	const tasksRepo = deps?.tasksRepo ?? (db ? createTasksRepo(db) : undefined);
	const documentsRepo = deps?.documentsRepo ?? (db ? createDocumentsRepo(db) : undefined);

	return {
		runner,
		worktreeDeps,
		tasksRepo,
		documentsRepo,
	};
}

/**
 * Generates the read-only landing checklist for a completed/reviewed task (AC 1, AC 3, E-74).
 * Returns worktreePath, branchName, diffStat, and copyable commands.
 * Product does not execute commit, push, PR, merge, or python maintenance scripts.
 */
export async function getTaskLanding(
	input: GetTaskLandingInput,
	deps?: TaskLandingServiceDeps,
): Promise<GetTaskLandingResponse> {
	if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'taskId must be a non-empty string');
	}
	const cleanTaskId = input.taskId.trim();

	const { runner, worktreeDeps, tasksRepo, documentsRepo } = resolveRunnerAndDeps(deps);

	const metadata = resolveTaskMetadata(cleanTaskId, tasksRepo, documentsRepo);
	if (tasksRepo && !metadata.taskRow && !input.worktreePath) {
		throw new AppError('E_NOT_FOUND', `Task not found: ${cleanTaskId}`);
	}

	const taskKey = input.taskKey ?? metadata.taskKey;
	const docsPath =
		input.docsPath ?? metadata.docsPath ?? deps?.docsPath ?? 'docs/Agent任务调度器-开发文档';
	const branchPrefix = metadata.branchPrefix ?? deps?.defaultBranchPrefix ?? 'task/';
	const repoPath = nodePath.resolve(
		input.repoPath ?? metadata.repoPath ?? deps?.repoPath ?? process.cwd(),
	);

	let worktreePath: string;
	let branchName: string;

	if (input.worktreePath) {
		worktreePath = nodePath.resolve(input.worktreePath);
		branchName = input.branchName ?? `${branchPrefix}${taskKey}`;
	} else {
		const matching = await findMatchingWorktree(repoPath, taskKey, cleanTaskId, runner);
		if (matching) {
			worktreePath = nodePath.resolve(matching.path);
			branchName = matching.branch
				? matching.branch.replace(/^refs\/heads\//, '')
				: `${branchPrefix}${taskKey}`;
		} else {
			worktreePath = resolveDefaultWorktreePath(repoPath, taskKey);
			branchName = `${branchPrefix}${taskKey}`;
		}
	}

	const exists = await checkDirectoryExists(worktreePath, deps?.fs);
	if (!exists) {
		if (input.allowMissingWorktree) {
			const commands = generateLandingCommands({
				docsPath,
				taskId: taskKey,
				ghStackCommand: input.ghStackCommand,
			});
			return Object.freeze({
				worktreePath,
				branchName,
				diffStat: Object.freeze({ filesChanged: 0, insertions: 0, deletions: 0 }),
				commands,
			});
		}
		throw new AppError(
			'E_NOT_FOUND',
			`Worktree not found for task ${cleanTaskId}: ${worktreePath}`,
			{ details: { taskId: cleanTaskId, taskKey, worktreePath } },
		);
	}

	let diffStatResult: DiffStatResult;
	try {
		diffStatResult = await getDiffStat(worktreePath, {
			runner,
			deps: worktreeDeps,
			baseRef: input.baseRef,
			includeUntracked: true,
		});
	} catch (cause) {
		if (cause instanceof AppError) {
			if (cause.code === 'E_WORKSPACE_UNAVAILABLE') {
				throw new AppError(
					'E_NOT_FOUND',
					`Worktree path is inaccessible for task ${cleanTaskId}: ${worktreePath}`,
					{ cause, details: { taskId: cleanTaskId, worktreePath } },
				);
			}
			throw cause;
		}
		throw new AppError('E_INTERNAL', `Failed to get diff stat for worktree: ${worktreePath}`, {
			cause,
			details: { taskId: cleanTaskId, worktreePath },
		});
	}

	const commands = generateLandingCommands({
		docsPath,
		taskId: taskKey,
		ghStackCommand: input.ghStackCommand,
	});

	return Object.freeze({
		worktreePath,
		branchName,
		diffStat: Object.freeze({
			filesChanged: diffStatResult.filesChanged,
			insertions: diffStatResult.insertions,
			deletions: diffStatResult.deletions,
		}),
		commands,
	});
}

/**
 * Cleans up a task's worktree upon explicit user request (AC 2, E-73).
 * Worktrees are kept by default after task completion; only explicit cleanup removes it.
 * Once cleaned up, retrying a task requires rebuilding the worktree.
 */
export async function cleanupTaskWorktree(
	input: CleanupTaskWorktreeInput,
	deps?: TaskLandingServiceDeps,
): Promise<CleanupTaskWorktreeResponse> {
	if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'taskId must be a non-empty string');
	}
	const cleanTaskId = input.taskId.trim();

	const { runner, worktreeDeps, tasksRepo, documentsRepo } = resolveRunnerAndDeps(deps);

	const metadata = resolveTaskMetadata(cleanTaskId, tasksRepo, documentsRepo);
	if (tasksRepo && !metadata.taskRow && !input.worktreePath) {
		throw new AppError('E_NOT_FOUND', `Task not found: ${cleanTaskId}`);
	}

	const taskKey = input.taskKey ?? metadata.taskKey;
	const repoPath = nodePath.resolve(
		input.repoPath ?? metadata.repoPath ?? deps?.repoPath ?? process.cwd(),
	);

	let targetWorktreePath: string;
	let matchingBranch: string | undefined;

	if (input.worktreePath) {
		targetWorktreePath = nodePath.resolve(input.worktreePath);
	} else {
		const matching = await findMatchingWorktree(repoPath, taskKey, cleanTaskId, runner);
		if (matching) {
			targetWorktreePath = nodePath.resolve(matching.path);
			matchingBranch = matching.branch ? matching.branch.replace(/^refs\/heads\//, '') : undefined;
		} else {
			targetWorktreePath = resolveDefaultWorktreePath(repoPath, taskKey);
		}
	}

	const removeInput: CleanupWorktreeInput = {
		repoPath,
		worktreePath: targetWorktreePath,
		force: input.force ?? true,
		deleteBranch: input.deleteBranch ?? false,
		branchName: input.branchName ?? matchingBranch,
	};

	await removeWorktree(removeInput, runner, worktreeDeps);

	return Object.freeze({
		removed: true,
	});
}

/**
 * Creates a landing service instance bundling landing checklist generation and worktree cleanup.
 */
export function createLandingService(deps: TaskLandingServiceDeps): TaskLandingService {
	return Object.freeze({
		getLanding(input: GetTaskLandingInput) {
			return getTaskLanding(input, deps);
		},
		cleanupWorktree(input: CleanupTaskWorktreeInput) {
			return cleanupTaskWorktree(input, deps);
		},
		generateLandingCommands(options: GenerateLandingCommandsOptions) {
			return generateLandingCommands(options);
		},
	});
}
