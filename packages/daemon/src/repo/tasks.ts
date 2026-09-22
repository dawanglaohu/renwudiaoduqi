import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import { batchNoOf } from '../domain/layer-of.ts';
import { AppError } from '../errors/app-error.ts';
import { type BatchRow, type BatchesRepo, createBatchesRepo } from './batches.ts';

export interface TaskRow {
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
	readonly lane_no?: number | null;
	/** Per-task assignment draft JSON written by `POST /batches/:id/assignments` (M8-T11). */
	readonly assignment_draft_json?: string | null;
}

export interface TaskInsertRow {
	readonly id: string;
	readonly doc_id: string;
	readonly task_key: string;
	readonly title: string;
	readonly module_key: string;
	readonly deps_json: string;
	readonly input_text?: string | null;
	readonly output_text?: string | null;
	readonly accept_text?: string | null;
	readonly edge_ids_json?: string | null;
	readonly task_paths_json?: string | null;
	readonly contract_hash: string;
	readonly is_contract_ready: number;
	readonly contract_reasons_json: string;
	readonly est_days?: number | null;
	readonly batch_id?: string | null;
	readonly impl_prompt?: string | null;
	readonly review_prompt?: string | null;
	readonly bug_prompt?: string | null;
	readonly is_removed_from_doc?: number;
	readonly has_accept_changed?: number;
	readonly has_prompt_changed?: number;
	readonly manual_state?: string | null;
	readonly lane_no?: number | null;
}

export interface TaskUpdateDocFieldsRow {
	readonly id: string;
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
	readonly bug_prompt?: string | null;
	readonly is_removed_from_doc: number;
}

export interface GhostDependency {
	readonly taskId: string;
	readonly ghostDepKey: string;
}

export interface TaskCycle {
	readonly cycle: readonly string[];
	readonly taskIds: readonly string[];
}

export interface DependencyValidationReport {
	readonly hasDependencyIssues: boolean;
	readonly canAutoDispatch: boolean;
	readonly ghostDependencies: readonly GhostDependency[];
	readonly ghostKeys: readonly string[];
	readonly cycleTaskKeys: readonly string[];
	readonly cycles: readonly TaskCycle[];
	readonly reasons: readonly string[];
}

export interface ParsedDocTaskInput {
	readonly id: string;
	readonly title: string;
	readonly module: string;
	readonly deps: readonly string[];
	readonly input?: string | null;
	readonly output?: string | null;
	readonly accept: string;
	readonly estDays?: number | null;
	readonly edgeIds?: readonly string[];
	readonly contractHash: string;
	readonly isContractReady: boolean;
	readonly contractReasons: readonly string[];
	readonly taskPaths: readonly string[];
	readonly implPrompt: string;
	readonly reviewPrompt: string;
	readonly resumePrompt?: string | null;
	readonly bugPrompt?: string | null;
}

export interface ImportDocTasksParams {
	readonly docId: string;
	readonly tasks: readonly ParsedDocTaskInput[];
	readonly idGenerator?: () => string;
}

export interface ImportDocTasksResult {
	readonly tasks: readonly TaskRow[];
	readonly batches: readonly BatchRow[];
	readonly report: DependencyValidationReport;
}

const INSERT_SQL = `
INSERT INTO tasks (
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
) VALUES (
	@id,
	@doc_id,
	@task_key,
	@title,
	@module_key,
	@deps_json,
	@input_text,
	@output_text,
	@accept_text,
	@edge_ids_json,
	@task_paths_json,
	@contract_hash,
	@is_contract_ready,
	@contract_reasons_json,
	@est_days,
	@batch_id,
	@impl_prompt,
	@review_prompt,
	@bug_prompt,
	@is_removed_from_doc,
	@has_accept_changed,
	@has_prompt_changed,
	@manual_state
)
`;

const SELECT_BY_ID_SQL = `
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

const SELECT_BY_DOC_AND_KEY_SQL = `
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
WHERE doc_id = ? AND task_key = ?
LIMIT 1
`;

const SELECT_BY_DOC_ID_SQL = `
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

const SELECT_BY_BATCH_ID_SQL = `
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
WHERE batch_id = ?
ORDER BY task_key ASC
`;

const SELECT_TASKS_WITH_STATE_SQL = `
SELECT
	t.id,
	t.doc_id,
	t.task_key,
	t.title,
	t.module_key,
	t.deps_json,
	t.input_text,
	t.output_text,
	t.accept_text,
	t.edge_ids_json,
	t.task_paths_json,
	t.contract_hash,
	t.is_contract_ready,
	t.contract_reasons_json,
	t.est_days,
	t.batch_id,
	t.impl_prompt,
	t.review_prompt,
	t.bug_prompt,
	t.is_removed_from_doc,
	t.has_accept_changed,
	t.has_prompt_changed,
	t.manual_state,
	COALESCE(t.manual_state, r.state, 'never_dispatched') AS derived_state
FROM tasks t
LEFT JOIN runs r ON r.task_id = t.id AND r.attempt_no = (
	SELECT MAX(r2.attempt_no) FROM runs r2 WHERE r2.task_id = t.id
)
WHERE t.doc_id = ?
	AND (? IS NULL OR t.batch_id = ?)
	AND (? IS NULL OR COALESCE(t.manual_state, r.state, 'never_dispatched') = ?)
	AND (? IS NULL OR t.task_key > ?)
ORDER BY t.task_key ASC
LIMIT ?
`;

const UPDATE_DOC_FIELDS_SQL = `
UPDATE tasks
SET
	title = @title,
	module_key = @module_key,
	deps_json = @deps_json,
	input_text = @input_text,
	output_text = @output_text,
	accept_text = @accept_text,
	edge_ids_json = @edge_ids_json,
	task_paths_json = @task_paths_json,
	contract_hash = @contract_hash,
	is_contract_ready = @is_contract_ready,
	contract_reasons_json = @contract_reasons_json,
	est_days = @est_days,
	batch_id = @batch_id,
	impl_prompt = @impl_prompt,
	review_prompt = @review_prompt,
	bug_prompt = @bug_prompt,
	is_removed_from_doc = @is_removed_from_doc
WHERE id = @id
`;

const UPDATE_BATCH_ID_SQL = `
UPDATE tasks
SET batch_id = ?
WHERE id = ?
`;

const UPDATE_MANUAL_STATE_SQL = `
UPDATE tasks
SET manual_state = ?
WHERE id = ?
`;

const UPDATE_REMOVED_FROM_DOC_SQL = `
UPDATE tasks
SET is_removed_from_doc = 1
WHERE id = ?
`;

const UPDATE_ASSIGNMENT_DRAFT_SQL = `
UPDATE tasks
SET assignment_draft_json = ?
WHERE id = ?
`;

const DELETE_BY_ID_SQL = `
DELETE FROM tasks
WHERE id = ?
`;

const DELETE_BY_DOC_ID_SQL = `
DELETE FROM tasks
WHERE doc_id = ?
`;

/**
 * 校验任务依赖的完整性（E-20、E-241、E-242）：
 * 1. 幽灵依赖：依赖的 ID 在当前文档任务中不存在，记录在报告中并在分层时忽略；
 * 2. 依赖成环：识别所有处于环上的任务 ID 和环链，报告中显式列出；
 * 3. 当存在幽灵依赖或成环时，标记 hasDependencyIssues=true 且 canAutoDispatch=false（阻断自动批次派发）。
 */
export function validateTaskDependencies(
	tasks: readonly { readonly id: string; readonly deps?: readonly string[] }[],
): DependencyValidationReport {
	const taskKeySet = new Set<string>();
	for (const t of tasks) {
		taskKeySet.add(t.id);
	}

	const ghostDependencies: GhostDependency[] = [];
	const ghostKeysSet = new Set<string>();
	const validDepsMap = new Map<string, string[]>();

	for (const t of tasks) {
		const validDeps: string[] = [];
		for (const dep of t.deps ?? []) {
			if (taskKeySet.has(dep)) {
				validDeps.push(dep);
			} else {
				ghostDependencies.push({ taskId: t.id, ghostDepKey: dep });
				ghostKeysSet.add(dep);
			}
		}
		validDepsMap.set(t.id, validDeps);
	}

	// 环检测：一个节点在环上，当且仅当它沿着有效依赖能回到自身
	const cycleTaskKeysSet = new Set<string>();
	for (const taskKey of taskKeySet) {
		const visited = new Set<string>();
		const queue = [...(validDepsMap.get(taskKey) ?? [])];
		let reachesSelf = false;

		while (queue.length > 0) {
			const curr = queue.shift();
			if (!curr) continue;
			if (curr === taskKey) {
				reachesSelf = true;
				break;
			}
			if (!visited.has(curr)) {
				visited.add(curr);
				const nextDeps = validDepsMap.get(curr) ?? [];
				for (const next of nextDeps) {
					queue.push(next);
				}
			}
		}

		if (reachesSelf) {
			cycleTaskKeysSet.add(taskKey);
		}
	}

	// 提取环链信息供导入报告与 UI 提示
	const cycles: TaskCycle[] = [];
	const seenCycleSignatures = new Set<string>();

	if (cycleTaskKeysSet.size > 0) {
		const path: string[] = [];
		const inPath = new Set<string>();

		function findCycleDfs(curr: string) {
			path.push(curr);
			inPath.add(curr);

			for (const dep of validDepsMap.get(curr) ?? []) {
				if (!cycleTaskKeysSet.has(dep)) continue;

				if (inPath.has(dep)) {
					const idx = path.indexOf(dep);
					if (idx >= 0) {
						const cycle = path.slice(idx).concat(dep);
						const taskIds = Array.from(new Set(cycle.slice(0, -1))).sort();
						const sig = taskIds.join(',');
						if (!seenCycleSignatures.has(sig)) {
							seenCycleSignatures.add(sig);
							cycles.push(
								Object.freeze({
									cycle: Object.freeze(cycle),
									taskIds: Object.freeze(taskIds),
								}),
							);
						}
					}
				} else {
					findCycleDfs(dep);
				}
			}

			inPath.delete(curr);
			path.pop();
		}

		for (const key of cycleTaskKeysSet) {
			findCycleDfs(key);
		}
	}

	const reasons: string[] = [];
	if (ghostDependencies.length > 0) {
		for (const g of ghostDependencies) {
			reasons.push(`Task "${g.taskId}" references non-existent dependency "${g.ghostDepKey}"`);
		}
	}
	if (cycleTaskKeysSet.size > 0) {
		for (const c of cycles) {
			reasons.push(`Dependency cycle detected: ${c.cycle.join(' -> ')}`);
		}
		if (cycles.length === 0) {
			reasons.push(
				`Dependency cycle detected involving tasks: ${Array.from(cycleTaskKeysSet).sort().join(', ')}`,
			);
		}
	}

	const hasDependencyIssues = ghostDependencies.length > 0 || cycleTaskKeysSet.size > 0;
	const canAutoDispatch = !hasDependencyIssues;

	return Object.freeze({
		hasDependencyIssues,
		canAutoDispatch,
		ghostDependencies: Object.freeze(ghostDependencies.map((g) => Object.freeze({ ...g }))),
		ghostKeys: Object.freeze(Array.from(ghostKeysSet).sort()),
		cycleTaskKeys: Object.freeze(Array.from(cycleTaskKeysSet).sort()),
		cycles: Object.freeze(cycles),
		reasons: Object.freeze(reasons),
	});
}

export interface ListTasksFilter {
	readonly docId: string;
	readonly batchId?: string | null;
	readonly state?: string | null;
	readonly cursor?: string | null;
	readonly limit: number;
}

export interface TaskWithDerivedStateRow extends TaskRow {
	readonly derived_state: string;
}

export interface TasksRepo {
	readonly insert: (row: TaskInsertRow) => void;
	readonly insertMany: (rows: readonly TaskInsertRow[]) => void;
	readonly findById: (id: string) => TaskRow | null;
	readonly findByDocAndKey: (docId: string, taskKey: string) => TaskRow | null;
	readonly listByDocId: (docId: string) => readonly TaskRow[];
	readonly listByBatchId: (batchId: string) => readonly TaskRow[];
	readonly listTasksWithDerivedState: (
		filter: ListTasksFilter,
	) => readonly TaskWithDerivedStateRow[];
	readonly updateDocFields: (row: TaskUpdateDocFieldsRow) => void;
	readonly updateBatchId: (id: string, batchId: string | null) => void;
	readonly updateManualState: (id: string, manualState: string | null) => void;
	readonly markRemovedFromDoc: (docId: string, activeTaskKeys: readonly string[]) => void;
	readonly clearLaneNo: (taskId: string) => {
		readonly changes: number;
		readonly previousLaneNo: number | null;
		readonly docId: string | null;
	};
	readonly setLaneNo: (taskId: string, laneNo: number) => void;
	/**
	 * Overwrites one task's assignment draft; `null` clears it (M8-T11, E-108).
	 * Callers overwrite a whole batch by calling this per task inside one unit of work.
	 */
	readonly setAssignmentDraft: (taskId: string, draftJson: string | null) => void;
	readonly deleteById: (id: string) => void;
	readonly deleteByDocId: (docId: string) => void;
}

function freezeTaskRow(row: TaskRow): TaskRow {
	return Object.freeze({
		...row,
		lane_no: row.lane_no ?? null,
		assignment_draft_json: row.assignment_draft_json ?? null,
	});
}

export function createTasksRepo(db: DatabaseConnection): TasksRepo {
	let hasBugPrompt = false;
	let hasLaneNo = false;
	let hasAssignmentDraft = false;
	try {
		const tableInfo = db.prepare<[], { name: string }>('PRAGMA table_info(tasks)').all();
		hasBugPrompt = tableInfo.some((col) => col.name === 'bug_prompt');
		hasLaneNo = tableInfo.some((col) => col.name === 'lane_no');
		hasAssignmentDraft = tableInfo.some((col) => col.name === 'assignment_draft_json');
	} catch {}

	let insertSql = INSERT_SQL;
	if (!hasBugPrompt) {
		insertSql = insertSql.replace('\t@bug_prompt,\n', '').replace('\tbug_prompt,\n', '');
	}
	if (hasLaneNo) {
		insertSql = insertSql
			.replace('\tmanual_state\n)', '\tmanual_state,\n\tlane_no\n)')
			.replace('\t@manual_state\n)', '\t@manual_state,\n\t@lane_no\n)');
	}

	function adjustSelectSql(baseSql: string) {
		let sql = baseSql;
		if (!hasBugPrompt) {
			sql = sql.replace('\tbug_prompt,\n', '');
		}
		if (hasLaneNo) {
			sql = sql.replace('\tmanual_state\n', '\tmanual_state,\n\tlane_no\n');
		}
		if (hasAssignmentDraft) {
			sql = sql.replace('\nFROM tasks\n', ',\n\tassignment_draft_json\nFROM tasks\n');
		}
		return sql;
	}

	function adjustJoinSelectSql(baseSql: string) {
		let sql = baseSql;
		if (!hasBugPrompt) {
			sql = sql.replace('\tt.bug_prompt,\n', '');
		}
		if (hasLaneNo) {
			sql = sql.replace('\tt.manual_state,\n', '\tt.manual_state,\n\tt.lane_no,\n');
		}
		if (hasAssignmentDraft) {
			sql = sql.replace('\nFROM tasks t\n', ',\n\tt.assignment_draft_json\nFROM tasks t\n');
		}
		return sql;
	}

	const insertStmt = db.prepare(insertSql);
	const selectByIdStmt = db.prepare(adjustSelectSql(SELECT_BY_ID_SQL));
	const selectByDocAndKeyStmt = db.prepare(adjustSelectSql(SELECT_BY_DOC_AND_KEY_SQL));
	const selectByDocIdStmt = db.prepare(adjustSelectSql(SELECT_BY_DOC_ID_SQL));
	const selectByBatchIdStmt = db.prepare(adjustSelectSql(SELECT_BY_BATCH_ID_SQL));
	let listTasksWithDerivedStateStmt: ReturnType<
		typeof db.prepare<unknown[], TaskRow & { derived_state: string }>
	> | null = null;
	function getListTasksWithDerivedStateStmt() {
		if (!listTasksWithDerivedStateStmt) {
			listTasksWithDerivedStateStmt = db.prepare(adjustJoinSelectSql(SELECT_TASKS_WITH_STATE_SQL));
		}
		return listTasksWithDerivedStateStmt;
	}
	const updateDocFieldsStmt = db.prepare(UPDATE_DOC_FIELDS_SQL);
	const updateBatchIdStmt = db.prepare(UPDATE_BATCH_ID_SQL);
	const updateManualStateStmt = db.prepare(UPDATE_MANUAL_STATE_SQL);
	const updateRemovedStmt = db.prepare(UPDATE_REMOVED_FROM_DOC_SQL);
	const clearLaneNoStmt = hasLaneNo
		? db.prepare('UPDATE tasks SET lane_no = NULL WHERE id = ? AND lane_no IS NOT NULL')
		: null;
	const setLaneNoStmt = hasLaneNo ? db.prepare('UPDATE tasks SET lane_no = ? WHERE id = ?') : null;
	const setAssignmentDraftStmt = hasAssignmentDraft
		? db.prepare(UPDATE_ASSIGNMENT_DRAFT_SQL)
		: null;
	const deleteByIdStmt = db.prepare(DELETE_BY_ID_SQL);
	const deleteByDocIdStmt = db.prepare(DELETE_BY_DOC_ID_SQL);

	function buildInsertParams(row: TaskInsertRow) {
		const params: Record<string, unknown> = {
			id: row.id,
			doc_id: row.doc_id,
			task_key: row.task_key,
			title: row.title,
			module_key: row.module_key,
			deps_json: row.deps_json,
			input_text: row.input_text ?? null,
			output_text: row.output_text ?? null,
			accept_text: row.accept_text ?? null,
			edge_ids_json: row.edge_ids_json ?? null,
			task_paths_json: row.task_paths_json ?? null,
			contract_hash: row.contract_hash,
			is_contract_ready: row.is_contract_ready === 1 ? 1 : 0,
			contract_reasons_json: row.contract_reasons_json,
			est_days: row.est_days ?? null,
			batch_id: row.batch_id ?? null,
			impl_prompt: row.impl_prompt ?? null,
			review_prompt: row.review_prompt ?? null,
			is_removed_from_doc: row.is_removed_from_doc === 1 ? 1 : 0,
			has_accept_changed: row.has_accept_changed === 1 ? 1 : 0,
			has_prompt_changed: row.has_prompt_changed === 1 ? 1 : 0,
			manual_state: row.manual_state ?? null,
		};
		if (hasBugPrompt) {
			params.bug_prompt = row.bug_prompt ?? null;
		}
		if (hasLaneNo) {
			params.lane_no = row.lane_no ?? null;
		}
		return params;
	}

	return Object.freeze({
		insert(row: TaskInsertRow): void {
			try {
				insertStmt.run(buildInsertParams(row));
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to insert task: docId=${row.doc_id}, taskKey=${row.task_key}`,
				);
			}
		},

		insertMany(rows: readonly TaskInsertRow[]): void {
			try {
				for (const row of rows) {
					insertStmt.run(buildInsertParams(row));
				}
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to insert tasks batch');
			}
		},

		findById(id: string): TaskRow | null {
			try {
				const row = selectByIdStmt.get(id) as TaskRow | undefined;
				return row ? freezeTaskRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find task by id: ${id}`);
			}
		},

		findByDocAndKey(docId: string, taskKey: string): TaskRow | null {
			try {
				const row = selectByDocAndKeyStmt.get(docId, taskKey) as TaskRow | undefined;
				return row ? freezeTaskRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find task by docId and key: ${docId}, ${taskKey}`);
			}
		},

		listByDocId(docId: string): readonly TaskRow[] {
			try {
				const rows = selectByDocIdStmt.all(docId) as TaskRow[];
				return Object.freeze(rows.map(freezeTaskRow));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list tasks by docId: ${docId}`);
			}
		},

		listByBatchId(batchId: string): readonly TaskRow[] {
			try {
				const rows = selectByBatchIdStmt.all(batchId) as TaskRow[];
				return Object.freeze(rows.map(freezeTaskRow));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list tasks by batchId: ${batchId}`);
			}
		},

		listTasksWithDerivedState(filter: ListTasksFilter): readonly TaskWithDerivedStateRow[] {
			try {
				let cursorTaskKey = filter.cursor ?? null;
				if (cursorTaskKey) {
					const task = selectByIdStmt.get(cursorTaskKey) as TaskRow | undefined;
					if (task) {
						cursorTaskKey = task.task_key;
					}
				}

				const rows = getListTasksWithDerivedStateStmt().all(
					filter.docId,
					filter.batchId ?? null,
					filter.batchId ?? null,
					filter.state ?? null,
					filter.state ?? null,
					cursorTaskKey,
					cursorTaskKey,
					filter.limit,
				) as (TaskRow & { derived_state: string })[];

				return Object.freeze(
					rows.map((row) =>
						Object.freeze({
							...freezeTaskRow(row),
							derived_state: row.derived_state,
						}),
					),
				);
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to list tasks with derived state: docId=${filter.docId}`,
				);
			}
		},

		updateDocFields(row: TaskUpdateDocFieldsRow): void {
			try {
				updateDocFieldsStmt.run({
					id: row.id,
					title: row.title,
					module_key: row.module_key,
					deps_json: row.deps_json,
					input_text: row.input_text ?? null,
					output_text: row.output_text ?? null,
					accept_text: row.accept_text ?? null,
					edge_ids_json: row.edge_ids_json ?? null,
					task_paths_json: row.task_paths_json ?? null,
					contract_hash: row.contract_hash,
					is_contract_ready: row.is_contract_ready === 1 ? 1 : 0,
					contract_reasons_json: row.contract_reasons_json,
					est_days: row.est_days ?? null,
					batch_id: row.batch_id ?? null,
					impl_prompt: row.impl_prompt ?? null,
					review_prompt: row.review_prompt ?? null,
					bug_prompt: row.bug_prompt ?? null,
					is_removed_from_doc: row.is_removed_from_doc === 1 ? 1 : 0,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update task doc fields: ${row.id}`);
			}
		},

		updateBatchId(id: string, batchId: string | null): void {
			try {
				updateBatchIdStmt.run(batchId ?? null, id);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update task batchId: ${id}`);
			}
		},

		updateManualState(id: string, manualState: string | null): void {
			try {
				updateManualStateStmt.run(manualState ?? null, id);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update task manual_state: ${id}`);
			}
		},

		markRemovedFromDoc(docId: string, activeTaskKeys: readonly string[]): void {
			try {
				const activeSet = new Set(activeTaskKeys);
				const existingRows = selectByDocIdStmt.all(docId) as TaskRow[];
				for (const row of existingRows) {
					if (!activeSet.has(row.task_key) && row.is_removed_from_doc === 0) {
						updateRemovedStmt.run(row.id);
					}
				}
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to mark tasks removed from doc for docId: ${docId}`);
			}
		},

		clearLaneNo(taskId: string): {
			readonly changes: number;
			readonly previousLaneNo: number | null;
			readonly docId: string | null;
		} {
			if (!clearLaneNoStmt) {
				return Object.freeze({ changes: 0, previousLaneNo: null, docId: null });
			}
			try {
				const existing = selectByIdStmt.get(taskId) as TaskRow | undefined;
				if (!existing || existing.lane_no === null || existing.lane_no === undefined) {
					return Object.freeze({
						changes: 0,
						previousLaneNo: null,
						docId: existing?.doc_id ?? null,
					});
				}
				const previousLaneNo = existing.lane_no;
				const info = clearLaneNoStmt.run(taskId);
				return Object.freeze({
					changes: info.changes,
					previousLaneNo,
					docId: existing.doc_id,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to clear lane_no for task: ${taskId}`);
			}
		},

		setLaneNo(taskId: string, laneNo: number): void {
			if (!setLaneNoStmt) return;
			try {
				setLaneNoStmt.run(laneNo, taskId);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to set lane_no for task: ${taskId}`);
			}
		},

		setAssignmentDraft(taskId: string, draftJson: string | null): void {
			if (!setAssignmentDraftStmt) {
				throw new AppError(
					'E_INTERNAL',
					'tasks.assignment_draft_json column is missing; migrations have not been applied.',
					{ details: { taskId } },
				);
			}
			try {
				setAssignmentDraftStmt.run(draftJson, taskId);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to set assignment draft for task: ${taskId}`);
			}
		},

		deleteById(id: string): void {
			try {
				deleteByIdStmt.run(id);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to delete task by id: ${id}`);
			}
		},

		deleteByDocId(docId: string): void {
			try {
				deleteByDocIdStmt.run(docId);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to delete tasks by docId: ${docId}`);
			}
		},
	});
}

function requireDatabase(db: DatabaseConnection | null, repoName: string): DatabaseConnection {
	if (!db) {
		throw new AppError(
			'E_INTERNAL',
			`importDocTasks needs either a database handle or an injected ${repoName}.`,
		);
	}
	return db;
}

/**
 * 导入文档任务与批次（M3-T2）：
 * 1. 校验任务依赖，产生导入报告（幽灵依赖、成环任务列出，阻断自动批次派发，E-20、E-241、E-242）；
 * 2. 按拓扑分层重算批次号，成环任务就地截断为层 0（落入第 1 批，E-241）；
 * 3. 全部任务无依赖时只有第 1 批，界面照常按批次呈现（E-244）；
 * 4. 批次号不作持久标识，历史派发记录认 task id 与快照，已有任务保留原始 id 与 manual_state（E-243）；
 *    批次行按 (doc_id, batch_no) upsert 且**永不删除**——重出分层只改任务的归属，批次行的 state 与已有收口记录原样保留；
 * 5. 多份文档按 doc_id 隔离，任务 id 不冲突，批次独立编号（E-21、E-87）；
 * 6. ready=false 的合法任务正常落库但 is_contract_ready=0，带阻断原因（E-17、E-82）。
 */
export function importDocTasks(
	db: DatabaseConnection | null,
	params: ImportDocTasksParams,
	repos?: {
		readonly tasksRepo?: TasksRepo;
		readonly batchesRepo?: BatchesRepo;
	},
): ImportDocTasksResult {
	const tasksRepo = repos?.tasksRepo ?? createTasksRepo(requireDatabase(db, 'tasksRepo'));
	const batchesRepo = repos?.batchesRepo ?? createBatchesRepo(requireDatabase(db, 'batchesRepo'));
	const idGenerator = params.idGenerator ?? randomUUID;

	// 1. 依赖校验：找出幽灵依赖与成环任务（E-20、E-241、E-242）
	const report = validateTaskDependencies(params.tasks);

	// 2. 算分层与批次号（E-241、E-243、E-244、E-246）
	const taskKeySet = new Set(params.tasks.map((t) => t.id));
	const taskKeys = Array.from(taskKeySet);
	const cycleTaskKeysSet = new Set(report.cycleTaskKeys);

	const validDepsMap = new Map<string, readonly string[]>();
	for (const t of params.tasks) {
		const valid = (t.deps ?? []).filter((d) => taskKeySet.has(d));
		validDepsMap.set(t.id, valid);
	}

	const taskLayers = new Map<string, number>();

	// E-241：成环任务就地截断为层 0（落进第 1 批）
	for (const key of cycleTaskKeysSet) {
		taskLayers.set(key, 0);
	}

	function computeLayer(id: string, visited: Set<string>): number {
		const cached = taskLayers.get(id);
		if (cached !== undefined) return cached;
		if (visited.has(id)) return 0; // 截断防死循环

		visited.add(id);
		let maxPred = 0;
		const deps = validDepsMap.get(id) ?? [];
		for (const p of deps) {
			const predLayer = computeLayer(p, visited);
			maxPred = Math.max(maxPred, predLayer + 1);
		}
		visited.delete(id);

		taskLayers.set(id, maxPred);
		return maxPred;
	}

	for (const t of params.tasks) {
		if (!taskLayers.has(t.id)) {
			computeLayer(t.id, new Set<string>());
		}
	}

	const taskBatchNos = new Map<string, number>();
	const batchNoSet = new Set<number>();

	for (const task of params.tasks) {
		const layer = taskLayers.get(task.id) ?? 0;
		const batchNo = batchNoOf(layer);
		taskBatchNos.set(task.id, batchNo);
		batchNoSet.add(batchNo);
	}

	// E-244：全部任务无依赖时只有第 1 批
	if (params.tasks.length > 0 && batchNoSet.size === 0) {
		batchNoSet.add(1);
	}
	const batchNos = Array.from(batchNoSet).sort((a, b) => a - b);

	// 3. 确保批次行存在并获取 batch_id 映射
	const batchMap = batchesRepo.ensureBatchesForDoc(params.docId, batchNos, idGenerator);

	// 4. 落库 tasks 表
	for (const t of params.tasks) {
		const batchNo = taskBatchNos.get(t.id) ?? 1;
		const batchId = batchMap.get(batchNo)?.id ?? null;

		const existing = tasksRepo.findByDocAndKey(params.docId, t.id);
		if (existing) {
			// E-243：批次号不作持久标识，每次重算并更新 batch_id；保持已有的 task id 与 manual_state
			tasksRepo.updateDocFields({
				id: existing.id,
				title: t.title,
				module_key: t.module,
				deps_json: JSON.stringify(t.deps ?? []),
				input_text: t.input ?? null,
				output_text: t.output ?? null,
				accept_text: t.accept,
				edge_ids_json: JSON.stringify(t.edgeIds ?? []),
				task_paths_json: JSON.stringify(t.taskPaths ?? []),
				contract_hash: t.contractHash,
				is_contract_ready: t.isContractReady ? 1 : 0,
				contract_reasons_json: JSON.stringify(t.contractReasons ?? []),
				est_days: t.estDays ?? null,
				batch_id: batchId,
				impl_prompt: t.implPrompt,
				review_prompt: t.reviewPrompt,
				bug_prompt: t.bugPrompt ?? null,
				is_removed_from_doc: 0,
			});
		} else {
			const newTaskId = idGenerator();
			tasksRepo.insert({
				id: newTaskId,
				doc_id: params.docId,
				task_key: t.id,
				title: t.title,
				module_key: t.module,
				deps_json: JSON.stringify(t.deps ?? []),
				input_text: t.input ?? null,
				output_text: t.output ?? null,
				accept_text: t.accept,
				edge_ids_json: JSON.stringify(t.edgeIds ?? []),
				task_paths_json: JSON.stringify(t.taskPaths ?? []),
				contract_hash: t.contractHash,
				is_contract_ready: t.isContractReady ? 1 : 0,
				contract_reasons_json: JSON.stringify(t.contractReasons ?? []),
				est_days: t.estDays ?? null,
				batch_id: batchId,
				impl_prompt: t.implPrompt,
				review_prompt: t.reviewPrompt,
				bug_prompt: t.bugPrompt ?? null,
				is_removed_from_doc: 0,
				has_accept_changed: 0,
				has_prompt_changed: 0,
				manual_state: null,
			});
		}
	}

	// 5. 将文档中已消失的任务标为 is_removed_from_doc = 1（E-18、E-77）
	tasksRepo.markRemovedFromDoc(params.docId, taskKeys);

	// 6. 返回查询结果（批次行永不删除，未被引用的批次原样保留，09 节）
	const finalTasks = tasksRepo.listByDocId(params.docId);
	const finalBatches = batchesRepo.listByDocId(params.docId);

	return Object.freeze({
		tasks: finalTasks,
		batches: finalBatches,
		report,
	});
}
