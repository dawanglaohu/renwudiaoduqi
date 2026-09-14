import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import {
	type DispatchSnapshotComparisonInput,
	type DocChangeBannerData,
	type TaskDiffFilter,
	type TaskDiffResult,
	type TaskDocComparisonInput,
	checkTaskDispatchEligibility,
	computeDocDiffBanner,
	filterAffectedTasks,
} from '../domain/docs-fingerprint.ts';
import { AppError } from '../errors/app-error.ts';

export interface DispatchSnapshotRow {
	readonly id: string;
	readonly task_id: string;
	readonly input_text: string | null;
	readonly output_text: string | null;
	readonly accept_text: string | null;
	readonly impl_prompt: string | null;
	readonly review_prompt: string | null;
	readonly bug_prompt: string | null;
	readonly contract_hash: string;
	readonly task_paths_json: string;
	readonly launch_spec_json: string;
	readonly created_at: string;
}

export interface DispatchSnapshotInsertRow {
	readonly id: string;
	readonly task_id: string;
	readonly input_text?: string | null;
	readonly output_text?: string | null;
	readonly accept_text?: string | null;
	readonly impl_prompt?: string | null;
	readonly review_prompt?: string | null;
	readonly bug_prompt?: string | null;
	readonly contract_hash: string;
	readonly task_paths_json: string;
	readonly launch_spec_json: string;
	readonly created_at: string;
}

export interface CreateSnapshotForTaskParams {
	readonly taskId: string;
	readonly launchSpecJson: string;
	readonly createdAt: string;
	readonly snapshotId?: string;
}

/**
 * 验收标准并列展示数据（E-78：卡片并列展示「派发时快照 / 当前文档」两段验收标准）。
 */
export interface TaskAcceptanceComparison {
	readonly taskId: string;
	readonly taskKey: string;
	readonly hasAcceptChanged: boolean;
	readonly snapshotAcceptText: string | null;
	readonly currentAcceptText: string | null;
	readonly snapshotInputText: string | null;
	readonly currentInputText: string | null;
	readonly snapshotOutputText: string | null;
	readonly currentOutputText: string | null;
	readonly snapshotCreatedAt: string | null;
}

export interface TaskRecordForDiff {
	readonly id: string;
	readonly doc_id: string;
	readonly task_key: string;
	readonly title: string;
	readonly module_key: string;
	readonly deps_json: string;
	readonly input_text: string | null;
	readonly output_text: string | null;
	readonly accept_text: string | null;
	readonly edge_ids_json: string | null;
	readonly task_paths_json: string | null;
	readonly contract_hash: string;
	readonly is_contract_ready: number;
	readonly contract_reasons_json: string;
	readonly est_days: number | null;
	readonly batch_id: string | null;
	readonly impl_prompt: string | null;
	readonly review_prompt: string | null;
	readonly bug_prompt: string | null;
	readonly is_removed_from_doc: number;
	readonly has_accept_changed: number;
	readonly has_prompt_changed: number;
	readonly manual_state: string | null;
}

export interface DispatchSnapshotsRepo {
	/**
	 * 插入一份新的派发快照（E-19、E-93）。
	 */
	insert(snapshot: DispatchSnapshotInsertRow): void;

	/**
	 * 按快照主键 ID 查询快照。
	 */
	findById(id: string): DispatchSnapshotRow | null;

	/**
	 * 获取指定任务的「最近一次」派发快照（E-80）。
	 */
	findLatestByTaskId(taskId: string): DispatchSnapshotRow | null;

	/**
	 * 获取指定任务的所有历史派发快照，按时间倒序只读返回（E-80）。
	 */
	listByTaskId(taskId: string): readonly DispatchSnapshotRow[];

	/**
	 * 获取指定文档下所有任务各自的最新快照列表。
	 */
	findLatestForDoc(docId: string): readonly DispatchSnapshotRow[];

	/**
	 * 在派发瞬间读取当前任务数据并生成快照落库（E-19、E-81）。
	 * 若任务已从文档移除，则拒绝派发并抛出 E_TASK_REMOVED_FROM_DOC（E-18、E-77）。
	 */
	takeSnapshotForTask(params: CreateSnapshotForTaskParams): DispatchSnapshotRow;

	/**
	 * 更新指定任务的三标记（has_accept_changed, has_prompt_changed, 可选 is_removed_from_doc）。
	 */
	updateTaskChangedFlags(
		taskId: string,
		flags: {
			readonly hasAcceptChanged: number | boolean;
			readonly hasPromptChanged: number | boolean;
			readonly isRemovedFromDoc?: number | boolean;
		},
	): void;

	/**
	 * 检查指定任务是否有在途运行（queued / starting / running / awaiting_reply / reviewing / reworking）。
	 */
	hasActiveRuns(taskId: string): boolean;

	/**
	 * 获取任务的验收标准比对数据（用于 E-78 并列展示与重派操作）。
	 */
	getTaskAcceptanceComparison(taskId: string): TaskAcceptanceComparison | null;

	/**
	 * 重新计算文档下各任务与最近一次派发快照的比对结果，回写 tasks 表并返回横幅数据（E-19、E-77、E-78、E-80、E-81）。
	 * 若传入 activeTaskKeys，不在该集合内的任务将被标记为 is_removed_from_doc = 1。
	 */
	refreshDocDiff(docId: string, activeTaskKeys?: readonly string[]): DocChangeBannerData;

	/**
	 * 只读获取当前文档的比对横幅与受影响任务统计（E-19 呈现侧）。
	 */
	getDocDiffBanner(docId: string): DocChangeBannerData;
}

const INSERT_SNAPSHOT_SQL = `
INSERT INTO dispatch_snapshots (
	id,
	task_id,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	created_at
) VALUES (
	@id,
	@task_id,
	@input_text,
	@output_text,
	@accept_text,
	@impl_prompt,
	@review_prompt,
	@bug_prompt,
	@contract_hash,
	@task_paths_json,
	@launch_spec_json,
	@created_at
)
`;

const SELECT_SNAPSHOT_BY_ID_SQL = `
SELECT
	id,
	task_id,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	created_at
FROM dispatch_snapshots
WHERE id = ?
LIMIT 1
`;

const SELECT_LATEST_SNAPSHOT_BY_TASK_ID_SQL = `
SELECT
	id,
	task_id,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	created_at
FROM dispatch_snapshots
WHERE task_id = ?
ORDER BY created_at DESC, id DESC
LIMIT 1
`;

const SELECT_ALL_SNAPSHOTS_BY_TASK_ID_SQL = `
SELECT
	id,
	task_id,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	created_at
FROM dispatch_snapshots
WHERE task_id = ?
ORDER BY created_at DESC, id DESC
`;

const SELECT_LATEST_SNAPSHOTS_BY_DOC_ID_SQL = `
WITH ranked AS (
	SELECT
		s.id,
		s.task_id,
		s.input_text,
		s.output_text,
		s.accept_text,
		s.impl_prompt,
		s.review_prompt,
		s.bug_prompt,
		s.contract_hash,
		s.task_paths_json,
		s.launch_spec_json,
		s.created_at,
		ROW_NUMBER() OVER (
			PARTITION BY s.task_id
			ORDER BY s.created_at DESC, s.id DESC
		) AS rn
	FROM dispatch_snapshots s
	INNER JOIN tasks t ON t.id = s.task_id
	WHERE t.doc_id = ?
)
SELECT
	id,
	task_id,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	created_at
FROM ranked
WHERE rn = 1
`;

const SELECT_TASK_BY_ID_SQL = `
SELECT
	id,
	doc_id,
	task_key,
	title,
	module_key,
	deps_json,
	input_text,
	output_text,
	accept_text,
	edge_ids_json,
	task_paths_json,
	contract_hash,
	is_contract_ready,
	contract_reasons_json,
	est_days,
	batch_id,
	impl_prompt,
	review_prompt,
	bug_prompt,
	is_removed_from_doc,
	has_accept_changed,
	has_prompt_changed,
	manual_state
FROM tasks
WHERE id = ?
LIMIT 1
`;

const SELECT_TASKS_BY_DOC_ID_SQL = `
SELECT
	id,
	doc_id,
	task_key,
	title,
	module_key,
	deps_json,
	input_text,
	output_text,
	accept_text,
	edge_ids_json,
	task_paths_json,
	contract_hash,
	is_contract_ready,
	contract_reasons_json,
	est_days,
	batch_id,
	impl_prompt,
	review_prompt,
	bug_prompt,
	is_removed_from_doc,
	has_accept_changed,
	has_prompt_changed,
	manual_state
FROM tasks
WHERE doc_id = ?
ORDER BY task_key ASC
`;

const UPDATE_TASK_FLAGS_SQL = `
UPDATE tasks
SET
	has_accept_changed = @has_accept_changed,
	has_prompt_changed = @has_prompt_changed,
	is_removed_from_doc = @is_removed_from_doc
WHERE id = @id
`;

const MARK_TASK_REMOVED_SQL = `
UPDATE tasks
SET is_removed_from_doc = 1
WHERE id = ?
`;

const SELECT_ACTIVE_RUN_COUNT_BY_TASK_ID_SQL = `
SELECT COUNT(*) AS count
FROM runs
WHERE task_id = ?
  AND state IN ('queued', 'starting', 'running', 'awaiting_reply', 'reviewing', 'reworking')
`;

export function createDispatchSnapshotsRepo(db: DatabaseConnection): DispatchSnapshotsRepo {
	const insertSnapshotStmt = db.prepare(INSERT_SNAPSHOT_SQL);
	const selectSnapshotByIdStmt = db.prepare(SELECT_SNAPSHOT_BY_ID_SQL);
	const selectLatestSnapshotByTaskIdStmt = db.prepare(SELECT_LATEST_SNAPSHOT_BY_TASK_ID_SQL);
	const selectAllSnapshotsByTaskIdStmt = db.prepare(SELECT_ALL_SNAPSHOTS_BY_TASK_ID_SQL);
	const selectLatestSnapshotsByDocIdStmt = db.prepare(SELECT_LATEST_SNAPSHOTS_BY_DOC_ID_SQL);
	const selectTaskByIdStmt = db.prepare(SELECT_TASK_BY_ID_SQL);
	const selectTasksByDocIdStmt = db.prepare(SELECT_TASKS_BY_DOC_ID_SQL);
	const updateTaskFlagsStmt = db.prepare(UPDATE_TASK_FLAGS_SQL);
	const markTaskRemovedStmt = db.prepare(MARK_TASK_REMOVED_SQL);
	const selectActiveRunCountStmt = db.prepare(SELECT_ACTIVE_RUN_COUNT_BY_TASK_ID_SQL);

	function rowToSnapshot(row: DispatchSnapshotRow): DispatchSnapshotRow {
		return Object.freeze({
			id: row.id,
			task_id: row.task_id,
			input_text: row.input_text ?? null,
			output_text: row.output_text ?? null,
			accept_text: row.accept_text ?? null,
			impl_prompt: row.impl_prompt ?? null,
			review_prompt: row.review_prompt ?? null,
			bug_prompt: row.bug_prompt ?? null,
			contract_hash: row.contract_hash,
			task_paths_json: row.task_paths_json,
			launch_spec_json: row.launch_spec_json,
			created_at: row.created_at,
		});
	}

	function insertSnapshotInternal(snapshot: DispatchSnapshotInsertRow): void {
		try {
			insertSnapshotStmt.run({
				id: snapshot.id,
				task_id: snapshot.task_id,
				input_text: snapshot.input_text ?? null,
				output_text: snapshot.output_text ?? null,
				accept_text: snapshot.accept_text ?? null,
				impl_prompt: snapshot.impl_prompt ?? null,
				review_prompt: snapshot.review_prompt ?? null,
				bug_prompt: snapshot.bug_prompt ?? null,
				contract_hash: snapshot.contract_hash,
				task_paths_json: snapshot.task_paths_json,
				launch_spec_json: snapshot.launch_spec_json,
				created_at: snapshot.created_at,
			});
		} catch (cause) {
			throw toDatabaseError(
				cause,
				`Failed to insert dispatch snapshot: id=${snapshot.id}, taskId=${snapshot.task_id}`,
			);
		}
	}

	function findSnapshotByIdInternal(id: string): DispatchSnapshotRow | null {
		try {
			const row = selectSnapshotByIdStmt.get(id) as DispatchSnapshotRow | undefined;
			return row ? rowToSnapshot(row) : null;
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to find dispatch snapshot by id: ${id}`);
		}
	}

	function findLatestSnapshotByTaskIdInternal(taskId: string): DispatchSnapshotRow | null {
		try {
			const row = selectLatestSnapshotByTaskIdStmt.get(taskId) as DispatchSnapshotRow | undefined;
			return row ? rowToSnapshot(row) : null;
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to find latest dispatch snapshot for taskId: ${taskId}`);
		}
	}

	function listSnapshotsByTaskIdInternal(taskId: string): readonly DispatchSnapshotRow[] {
		try {
			const rows = selectAllSnapshotsByTaskIdStmt.all(taskId) as DispatchSnapshotRow[];
			return Object.freeze(rows.map(rowToSnapshot));
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to list dispatch snapshots for taskId: ${taskId}`);
		}
	}

	function findLatestSnapshotsForDocInternal(docId: string): readonly DispatchSnapshotRow[] {
		try {
			const rows = selectLatestSnapshotsByDocIdStmt.all(docId) as DispatchSnapshotRow[];
			return Object.freeze(rows.map(rowToSnapshot));
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to find latest dispatch snapshots for docId: ${docId}`);
		}
	}

	function getTaskRecordById(taskId: string): TaskRecordForDiff | null {
		try {
			const row = selectTaskByIdStmt.get(taskId) as TaskRecordForDiff | undefined;
			return row ? Object.freeze({ ...row }) : null;
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to get task by id: ${taskId}`);
		}
	}

	function getTasksByDocId(docId: string): readonly TaskRecordForDiff[] {
		try {
			const rows = selectTasksByDocIdStmt.all(docId) as TaskRecordForDiff[];
			return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to get tasks for docId: ${docId}`);
		}
	}

	function updateTaskFlagsInternal(
		taskId: string,
		flags: {
			readonly hasAcceptChanged: number | boolean;
			readonly hasPromptChanged: number | boolean;
			readonly isRemovedFromDoc?: number | boolean;
		},
	): void {
		try {
			const existing = getTaskRecordById(taskId);
			const isRemoved =
				flags.isRemovedFromDoc !== undefined
					? flags.isRemovedFromDoc
						? 1
						: 0
					: (existing?.is_removed_from_doc ?? 0);

			updateTaskFlagsStmt.run({
				id: taskId,
				has_accept_changed: flags.hasAcceptChanged ? 1 : 0,
				has_prompt_changed: flags.hasPromptChanged ? 1 : 0,
				is_removed_from_doc: isRemoved,
			});
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to update task changed flags: ${taskId}`);
		}
	}

	function hasActiveRunsInternal(taskId: string): boolean {
		try {
			const row = selectActiveRunCountStmt.get(taskId) as { count: number } | undefined;
			return (row?.count ?? 0) > 0;
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to check active runs for taskId: ${taskId}`);
		}
	}

	function getTaskAcceptanceComparisonInternal(taskId: string): TaskAcceptanceComparison | null {
		const task = getTaskRecordById(taskId);
		if (!task) return null;

		const latestSnapshot = findLatestSnapshotByTaskIdInternal(taskId);
		const snapshotAccept = latestSnapshot?.accept_text ?? null;
		const snapshotInput = latestSnapshot?.input_text ?? null;
		const snapshotOutput = latestSnapshot?.output_text ?? null;

		const hasAcceptChanged = latestSnapshot
			? (task.accept_text ?? '') !== (snapshotAccept ?? '') ||
				(task.input_text ?? '') !== (snapshotInput ?? '') ||
				(task.output_text ?? '') !== (snapshotOutput ?? '')
			: false;

		return Object.freeze({
			taskId: task.id,
			taskKey: task.task_key,
			hasAcceptChanged,
			snapshotAcceptText: snapshotAccept,
			currentAcceptText: task.accept_text,
			snapshotInputText: snapshotInput,
			currentInputText: task.input_text,
			snapshotOutputText: snapshotOutput,
			currentOutputText: task.output_text,
			snapshotCreatedAt: latestSnapshot?.created_at ?? null,
		});
	}

	function executeDocDiff(
		docId: string,
		activeTaskKeys?: readonly string[],
		persistUpdates = false,
	): DocChangeBannerData {
		const taskRows = getTasksByDocId(docId);
		const activeSet = activeTaskKeys ? new Set(activeTaskKeys) : null;

		if (persistUpdates && activeSet) {
			for (const task of taskRows) {
				if (!activeSet.has(task.task_key) && task.is_removed_from_doc === 0) {
					try {
						markTaskRemovedStmt.run(task.id);
					} catch (cause) {
						throw toDatabaseError(cause, `Failed to mark task removed from doc: taskId=${task.id}`);
					}
				}
			}
		}

		// 重新拉取或计算当前有效任务
		const freshTasks = persistUpdates && activeSet ? getTasksByDocId(docId) : taskRows;
		const latestSnapshots = findLatestSnapshotsForDocInternal(docId);
		const snapshotsMap = new Map<string, DispatchSnapshotComparisonInput>();

		for (const snap of latestSnapshots) {
			snapshotsMap.set(snap.task_id, {
				id: snap.id,
				taskId: snap.task_id,
				inputText: snap.input_text,
				outputText: snap.output_text,
				acceptText: snap.accept_text,
				implPrompt: snap.impl_prompt,
				reviewPrompt: snap.review_prompt,
				contractHash: snap.contract_hash,
				taskPathsJson: snap.task_paths_json,
				launchSpecJson: snap.launch_spec_json,
				createdAt: snap.created_at,
			});
		}

		const comparisonTasks: TaskDocComparisonInput[] = freshTasks.map((t) => ({
			id: t.id,
			taskKey: t.task_key,
			inputText: t.input_text,
			outputText: t.output_text,
			acceptText: t.accept_text,
			implPrompt: t.impl_prompt,
			reviewPrompt: t.review_prompt,
			contractHash: t.contract_hash,
			taskPathsJson: t.task_paths_json,
			isRemovedFromDoc: t.is_removed_from_doc,
		}));

		const bannerData = computeDocDiffBanner(docId, comparisonTasks, snapshotsMap, activeTaskKeys);

		if (persistUpdates) {
			for (const taskResult of bannerData.tasks) {
				updateTaskFlagsInternal(taskResult.taskId, {
					hasAcceptChanged: taskResult.hasAcceptChanged,
					hasPromptChanged: taskResult.hasPromptChanged,
					isRemovedFromDoc: taskResult.isRemovedFromDoc,
				});
			}
		}

		return bannerData;
	}

	return Object.freeze({
		insert: insertSnapshotInternal,
		findById: findSnapshotByIdInternal,
		findLatestByTaskId: findLatestSnapshotByTaskIdInternal,
		listByTaskId: listSnapshotsByTaskIdInternal,
		findLatestForDoc: findLatestSnapshotsForDocInternal,

		takeSnapshotForTask(params: CreateSnapshotForTaskParams): DispatchSnapshotRow {
			const task = getTaskRecordById(params.taskId);
			if (!task) {
				throw new AppError('E_NOT_FOUND', `Task not found: ${params.taskId}`);
			}

			// E-18、E-77：任务从文档移除后禁止再次派发；
			// 契约未复核是另一种阻断，必须报 E_DOC_CONTRACT_PENDING 并带上文档给出的 reasons（E-82）。
			const eligibility = checkTaskDispatchEligibility(task);
			if (!eligibility.canDispatch) {
				if (eligibility.blockReason === 'contract_not_ready') {
					throw new AppError(
						'E_DOC_CONTRACT_PENDING',
						`Task ${task.task_key} contract is not ready for dispatch.`,
						{
							details: {
								taskId: task.id,
								reasons: parseContractReasons(task.contract_reasons_json),
							},
						},
					);
				}
				throw new AppError(
					'E_TASK_REMOVED_FROM_DOC',
					`Task ${task.task_key} is removed from document and cannot be dispatched (E-18, E-77)`,
				);
			}

			// E-19、E-81：以派发那一刻读到的任务内容逐字快照
			const snapshotId = params.snapshotId ?? randomUUID();
			const snapshotRow: DispatchSnapshotInsertRow = {
				id: snapshotId,
				task_id: task.id,
				input_text: task.input_text,
				output_text: task.output_text,
				accept_text: task.accept_text,
				impl_prompt: task.impl_prompt,
				review_prompt: task.review_prompt,
				bug_prompt: task.bug_prompt ?? null,
				contract_hash: task.contract_hash,
				task_paths_json: task.task_paths_json ?? '[]',
				launch_spec_json: params.launchSpecJson,
				created_at: params.createdAt,
			};

			insertSnapshotInternal(snapshotRow);

			// 新快照取代旧的比对基准：派发时读到的内容此刻就是「当前文档」，
			// 相对上一个快照的验收／提示词变更标记随之失效，否则任务卡会显示过期角标，
			// 并让 E-180 的「旧快照盲跑」拦截误伤刚派发的新快照（E-19、E-78、E-80）。
			updateTaskFlagsInternal(task.id, {
				hasAcceptChanged: 0,
				hasPromptChanged: 0,
				isRemovedFromDoc: task.is_removed_from_doc,
			});

			return rowToSnapshot({
				...snapshotRow,
				input_text: snapshotRow.input_text ?? null,
				output_text: snapshotRow.output_text ?? null,
				accept_text: snapshotRow.accept_text ?? null,
				impl_prompt: snapshotRow.impl_prompt ?? null,
				review_prompt: snapshotRow.review_prompt ?? null,
				bug_prompt: snapshotRow.bug_prompt ?? null,
			});
		},

		updateTaskChangedFlags: updateTaskFlagsInternal,
		hasActiveRuns: hasActiveRunsInternal,
		getTaskAcceptanceComparison: getTaskAcceptanceComparisonInternal,

		refreshDocDiff(docId: string, activeTaskKeys?: readonly string[]): DocChangeBannerData {
			return executeDocDiff(docId, activeTaskKeys, true);
		},

		getDocDiffBanner(docId: string): DocChangeBannerData {
			return executeDocDiff(docId, undefined, false);
		},
	});
}

// 只被本文件使用的私有函数：contract_reasons_json 由文档导入写入，
// 读到非字符串数组（手改库等）时回落为空列表，不把解析失败带进派发错误里。
function parseContractReasons(raw: string): readonly string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return Object.freeze([]);
		return Object.freeze(parsed.filter((item): item is string => typeof item === 'string'));
	} catch {
		return Object.freeze([]);
	}
}

// 重新导出 domain 层的辅助过滤函数供消费
export {
	filterAffectedTasks,
	checkTaskDispatchEligibility,
	type DocChangeBannerData,
	type TaskDiffFilter,
	type TaskDiffResult,
};
