import type { DatabaseConnection } from '../db/open-database.ts';
import {
	BUILTIN_BUGHUNT_PROMPT,
	type BughuntPromptSource,
	PROMPT_SOURCE_BUILTIN,
	PROMPT_SOURCE_DOCS,
} from '../domain/bughunt-builtin-prompt.ts';
import { AppError } from '../errors/app-error.ts';
import {
	type DispatchSnapshotRow,
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../repo/documents.ts';
import { type TaskRow, type TasksRepo, createTasksRepo } from '../repo/tasks.ts';

export interface GetBughuntContextOptions {
	/**
	 * Specific snapshot ID to query. If omitted, uses the latest snapshot for the task (E-80).
	 */
	readonly snapshotId?: string;
}

/**
 * 查 bug 上下文（供 M7-T8 组装查 bug 提示词，AC 2）。
 * 严格包含派发时快照中的 bugPrompt，而非当前文档中的内容。
 */
export interface BughuntContext {
	readonly taskId: string;
	readonly taskKey: string;
	readonly snapshotId: string;
	readonly bugPrompt: string;
	readonly promptSource: BughuntPromptSource;
	readonly contractHash: string;
	readonly isSnapshot: true;
	readonly isReadOnly: true;
	readonly docChangedSinceDispatch: boolean;
	readonly createdAt: string;
}

export interface BughuntContextServiceDeps {
	readonly db?: DatabaseConnection;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly tasksRepo?: TasksRepo;
	readonly documentsRepo?: DocumentsRepo;
	readonly clock?: { readonly now: () => string };
}

export interface BughuntContextService {
	/**
	 * 获取指定任务的查 bug 上下文（AC 2, AC 3, E-19, E-316, E-50）。
	 * 供 M7-T8 组装查 bug 提示词。
	 * 严格返回派发时快照中的 bugPrompt 与 promptSource='docs'。
	 * 快照为 NULL 时返回内置通用查 bug 提示词并 promptSource='builtin'，
	 * 不抛错、不回落到当前文档、不让查 bug 阶段停摆。
	 */
	readonly getBughuntContext: (
		taskId: string,
		options?: GetBughuntContextOptions,
	) => BughuntContext;
}

export function createBughuntContextService(
	deps: BughuntContextServiceDeps,
): BughuntContextService {
	const snapshotsRepo: DispatchSnapshotsRepo =
		deps.dispatchSnapshotsRepo ??
		(deps.db
			? createDispatchSnapshotsRepo(deps.db)
			: (() => {
					throw new AppError(
						'E_VALIDATION',
						'Either dispatchSnapshotsRepo or db must be provided to BughuntContextService',
					);
				})());

	const tasksRepo: TasksRepo | undefined =
		deps.tasksRepo ?? (deps.db ? createTasksRepo(deps.db) : undefined);

	const documentsRepo: DocumentsRepo | undefined =
		deps.documentsRepo ?? (deps.db ? createDocumentsRepo(deps.db) : undefined);

	function resolveTask(rawTaskId: string): {
		taskRow: TaskRow | null;
		resolvedTaskId: string;
		taskKey: string;
	} {
		if (tasksRepo) {
			const byId = tasksRepo.findById(rawTaskId);
			if (byId) {
				return { taskRow: byId, resolvedTaskId: byId.id, taskKey: byId.task_key };
			}

			// If rawTaskId didn't match row id, check if it matches a task_key in any doc
			if (documentsRepo) {
				const docs = documentsRepo.listAll();
				for (const doc of docs) {
					const byKey = tasksRepo.findByDocAndKey(doc.id, rawTaskId);
					if (byKey) {
						return { taskRow: byKey, resolvedTaskId: byKey.id, taskKey: byKey.task_key };
					}
				}
			}
		}

		// Fallback: check if snapshot exists directly by rawTaskId
		const snap = snapshotsRepo.findLatestByTaskId(rawTaskId);
		if (snap) {
			return { taskRow: null, resolvedTaskId: snap.task_id, taskKey: rawTaskId };
		}

		return { taskRow: null, resolvedTaskId: rawTaskId, taskKey: rawTaskId };
	}

	function getBughuntContextInternal(
		taskId: string,
		options?: GetBughuntContextOptions,
	): BughuntContext {
		if (typeof taskId !== 'string' || taskId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'taskId must be a non-empty string');
		}
		const cleanTaskId = taskId.trim();

		const { taskRow, resolvedTaskId, taskKey } = resolveTask(cleanTaskId);

		let snapshot: DispatchSnapshotRow | null = null;
		if (options?.snapshotId) {
			snapshot = snapshotsRepo.findById(options.snapshotId);
			if (!snapshot || (snapshot.task_id !== resolvedTaskId && snapshot.task_id !== cleanTaskId)) {
				throw new AppError(
					'E_NOT_FOUND',
					`Dispatch snapshot not found for task ${cleanTaskId} with snapshotId: ${options.snapshotId}`,
				);
			}
		} else {
			snapshot = snapshotsRepo.findLatestByTaskId(resolvedTaskId);
			if (!snapshot && resolvedTaskId !== cleanTaskId) {
				snapshot = snapshotsRepo.findLatestByTaskId(cleanTaskId);
			}
		}

		// 若 taskRow 与 snapshot 均不存在，说明该任务在系统中完全不存在
		if (!taskRow && !snapshot) {
			throw new AppError('E_NOT_FOUND', `Task not found: ${cleanTaskId}`);
		}

		// AC 2 & E-316: 严格取派发快照那一刻的 bug_prompt。
		// 快照中的 bug_prompt 为 NULL（缺失或不是字符串）时，返回内置通用查 bug 提示词并 promptSource='builtin'。
		// 若快照记录尚不存在（如从未生成快照），同样返回内置提示词并 promptSource='builtin'。
		// 绝不抛错、绝不回落到当前文档的 tasks.bug_prompt、绝不让查 bug 阶段停摆。
		const snapshotBugPrompt = snapshot?.bug_prompt ?? null;
		const hasDocPrompt =
			typeof snapshotBugPrompt === 'string' && snapshotBugPrompt.trim().length > 0;

		// AC 3 & E-316: 返回的材料逐字不改写、不截断
		const bugPrompt = hasDocPrompt ? snapshotBugPrompt : BUILTIN_BUGHUNT_PROMPT;
		const promptSource: BughuntPromptSource = hasDocPrompt
			? PROMPT_SOURCE_DOCS
			: PROMPT_SOURCE_BUILTIN;

		// AC 3 & E-50: 文档指纹在途中变化时仍取快照那一份，不热改；标记文档是否在派发后变化
		const isDocChanged =
			taskRow && snapshot
				? taskRow.contract_hash !== snapshot.contract_hash ||
					taskRow.has_accept_changed === 1 ||
					taskRow.has_prompt_changed === 1 ||
					taskRow.is_removed_from_doc === 1
				: false;

		return Object.freeze({
			taskId: resolvedTaskId,
			taskKey,
			snapshotId: snapshot?.id ?? '',
			bugPrompt,
			promptSource,
			contractHash: snapshot?.contract_hash ?? taskRow?.contract_hash ?? '',
			isSnapshot: true,
			isReadOnly: true,
			docChangedSinceDispatch: isDocChanged,
			createdAt: snapshot?.created_at ?? '',
		});
	}

	return Object.freeze({
		getBughuntContext: getBughuntContextInternal,
	});
}

/**
 * 供 M7-T8 取用的独立 getBughuntContext 导出（任务卡要求的产出函数形式）。
 */
export function getBughuntContext(
	taskId: string,
	depsOrOptions?: BughuntContextServiceDeps | GetBughuntContextOptions,
	maybeOptions?: GetBughuntContextOptions,
): BughuntContext {
	let deps: BughuntContextServiceDeps = {};
	let options: GetBughuntContextOptions | undefined;

	if (depsOrOptions) {
		if (
			'db' in depsOrOptions ||
			'dispatchSnapshotsRepo' in depsOrOptions ||
			'tasksRepo' in depsOrOptions ||
			'documentsRepo' in depsOrOptions
		) {
			deps = depsOrOptions as BughuntContextServiceDeps;
			options = maybeOptions;
		} else {
			options = depsOrOptions as GetBughuntContextOptions;
		}
	}

	const service = createBughuntContextService(deps);
	return service.getBughuntContext(taskId, options);
}
