import type { DatabaseConnection } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import { type BatchRow, type BatchesRepo, createBatchesRepo } from '../repo/batches.ts';
import {
	type DispatchSnapshotRow,
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../repo/documents.ts';
import type { RunsRepo } from '../repo/runs.ts';
import { type TaskRow, type TasksRepo, createTasksRepo } from '../repo/tasks.ts';
import { createBatchService } from './batch.ts';

export interface GetReviewContextOptions {
	/**
	 * Specific snapshot ID to query. If omitted, uses the latest snapshot for the task (E-80).
	 */
	readonly snapshotId?: string;
}

/**
 * 审查上下文（供 M7 组装只读裁定包，AC 1）。
 * 严格包含派发时快照中的材料，而非当前文档中的内容。
 */
export interface ReviewContext {
	readonly taskId: string;
	readonly taskKey: string;
	readonly snapshotId: string;
	readonly reviewPrompt: string;
	readonly contractHash: string;
	readonly acceptText: string;
	readonly inputText: string | null;
	readonly outputText: string | null;
	readonly taskPaths: readonly string[];
	readonly launchSpecJson: string;
	readonly createdAt: string;
	/**
	 * 标识该审查材料严格来自派发时快照（AC 1）。
	 */
	readonly isSnapshot: true;
	/**
	 * 标识该材料为只读引用审查材料，供 M7 组装只读裁定包；
	 * 文档维护／提交／推送／合并等指令不得成为运行时权限（AC 1）。
	 */
	readonly isReadOnly: true;
	/**
	 * 文档在派发后是否已被重新生成并发生变更（E-50、E-78）。
	 */
	readonly docChangedSinceDispatch: boolean;
}

export interface HandleDocFingerprintChangeParams {
	readonly docId: string;
	readonly newFingerprint?: string;
	readonly reason?: string;
}

export interface DocFingerprintChangeResult {
	readonly docId: string;
	/** 受到影响并已从 'running' 暂停为 'paused' 的批次 ID 列表（E-50） */
	readonly pausedBatchIds: readonly string[];
	/** 当前正在执行的在途任务 ID 列表（继续用快照跑完，绝不热改，E-50） */
	readonly inFlightTaskIds: readonly string[];
	/** 是否有批次被暂停 */
	readonly hasPausedBatches: boolean;
	/** 暂停时间点 ISO8601 */
	readonly pausedAt: string;
}

export interface ReviewContextServiceDeps {
	readonly db?: DatabaseConnection;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly tasksRepo?: TasksRepo;
	readonly batchesRepo?: BatchesRepo;
	readonly documentsRepo?: DocumentsRepo;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly clock?: { readonly now: () => string };
}

export interface ReviewContextService {
	/**
	 * 获取指定任务的审查上下文（AC 1, AC 2, E-50）。
	 * 供 M7 组装只读裁定包。
	 * 严格返回派发时快照中的 reviewPrompt, contractHash, acceptText 等字段，
	 * 绝不回落到当前文档。快照缺失时抛出 E_NOT_FOUND。
	 */
	readonly getReviewContext: (taskId: string, options?: GetReviewContextOptions) => ReviewContext;

	/**
	 * 当文档指纹在批次执行途中发生变更时，处理变更并暂停在途批次（AC 3, E-50）。
	 * 已派任务继续使用快照跑完，绝不热改在途任务；
	 * 后续派发自动暂停（batch state -> 'paused'），等待人工确认。
	 */
	readonly handleDocFingerprintChange: (
		params: HandleDocFingerprintChangeParams,
	) => DocFingerprintChangeResult;

	/**
	 * 暂停指定文档下所有处于 'running' 状态的批次（E-50）。
	 */
	readonly pauseRunningBatchesForDoc: (docId: string, reason?: string) => readonly string[];

	/**
	 * 人工确认新文档后，将处于 'paused' 状态的批次恢复为 'running'（E-50）。
	 */
	readonly confirmDocChangeAndResumeBatch: (batchId: string) => BatchRow;

	/**
	 * 检查批次是否处于暂停状态，若暂停则阻止后续派发（E-50）。
	 */
	readonly isBatchPaused: (batchId: string) => boolean;

	/**
	 * 停止事件总线监听（如有）。
	 */
	readonly dispose: () => void;
}

function parseTaskPaths(raw: string | null): readonly string[] {
	if (!raw) return Object.freeze([]);
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
			return Object.freeze([...parsed]);
		}
	} catch {
		// Ignore invalid JSON and fallback to empty array
	}
	return Object.freeze([]);
}

export function createReviewContextService(deps: ReviewContextServiceDeps): ReviewContextService {
	const snapshotsRepo: DispatchSnapshotsRepo =
		deps.dispatchSnapshotsRepo ??
		(deps.db
			? createDispatchSnapshotsRepo(deps.db)
			: (() => {
					throw new AppError(
						'E_VALIDATION',
						'Either dispatchSnapshotsRepo or db must be provided to ReviewContextService',
					);
				})());

	const tasksRepo: TasksRepo | undefined =
		deps.tasksRepo ?? (deps.db ? createTasksRepo(deps.db) : undefined);

	const batchesRepo: BatchesRepo | undefined =
		deps.batchesRepo ?? (deps.db ? createBatchesRepo(deps.db) : undefined);

	const documentsRepo: DocumentsRepo | undefined =
		deps.documentsRepo ?? (deps.db ? createDocumentsRepo(deps.db) : undefined);

	const getNow = deps.clock?.now ?? (() => new Date().toISOString());

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

	function getReviewContext(taskId: string, options?: GetReviewContextOptions): ReviewContext {
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

		// AC 2: 快照缺失时明确报错，而不是回落到当前文档
		if (!snapshot) {
			throw new AppError(
				'E_NOT_FOUND',
				`Dispatch snapshot missing for task: ${cleanTaskId}. Cannot build review context without a dispatch snapshot.`,
			);
		}

		const taskPaths = parseTaskPaths(snapshot.task_paths_json);

		// AC 1 & E-50: 严格返回派发时快照中的审查材料，而非当前文档中的内容
		const isDocChanged = taskRow
			? taskRow.contract_hash !== snapshot.contract_hash ||
				taskRow.has_accept_changed === 1 ||
				taskRow.has_prompt_changed === 1 ||
				taskRow.is_removed_from_doc === 1
			: false;

		return Object.freeze({
			taskId: resolvedTaskId,
			taskKey,
			snapshotId: snapshot.id,
			reviewPrompt: snapshot.review_prompt ?? '',
			contractHash: snapshot.contract_hash,
			acceptText: snapshot.accept_text ?? '',
			inputText: snapshot.input_text ?? null,
			outputText: snapshot.output_text ?? null,
			taskPaths,
			launchSpecJson: snapshot.launch_spec_json,
			createdAt: snapshot.created_at,
			isSnapshot: true,
			isReadOnly: true,
			docChangedSinceDispatch: isDocChanged,
		});
	}

	function handleDocFingerprintChange(
		params: HandleDocFingerprintChangeParams,
	): DocFingerprintChangeResult {
		const now = getNow();
		const pausedBatchIds: string[] = [];
		const inFlightTaskIds: string[] = [];

		// 1. 查找当前文档下所有处于 'running' 状态的批次并置为 'paused'（E-50）
		if (batchesRepo) {
			const batchService = createBatchService({
				batchesRepo,
				tasksRepo: tasksRepo ?? ({} as unknown as TasksRepo),
				runsRepo: {} as unknown as RunsRepo,
				unitOfWork: { run: (fn) => fn() },
				clock: { now: getNow },
				bus: deps.bus,
				envelopeFactory: deps.envelopeFactory,
			});
			const batches = batchesRepo.listByDocId(params.docId);
			for (const batch of batches) {
				if (batch.state === 'running') {
					void batchService.transitionBatch(
						batch.id,
						'paused',
						params.reason ?? 'doc_fingerprint_changed',
					);
					pausedBatchIds.push(batch.id);
				}
			}
		}

		// 2. 识别所有在途任务（E-50：已派任务继续用快照跑完，绝不热改在途任务）
		if (tasksRepo) {
			const docTasks = tasksRepo.listByDocId(params.docId);
			for (const task of docTasks) {
				if (snapshotsRepo.hasActiveRuns(task.id)) {
					inFlightTaskIds.push(task.id);
				}
			}
		}

		return Object.freeze({
			docId: params.docId,
			pausedBatchIds: Object.freeze(pausedBatchIds),
			inFlightTaskIds: Object.freeze(inFlightTaskIds),
			hasPausedBatches: pausedBatchIds.length > 0,
			pausedAt: now,
		});
	}

	function pauseRunningBatchesForDoc(docId: string, reason?: string): readonly string[] {
		const result = handleDocFingerprintChange({ docId, reason });
		return result.pausedBatchIds;
	}

	function confirmDocChangeAndResumeBatch(batchId: string): BatchRow {
		if (!batchesRepo) {
			throw new AppError(
				'E_VALIDATION',
				'batchesRepo must be provided to confirm and resume batches',
			);
		}

		const batch = batchesRepo.findById(batchId);
		if (!batch) {
			throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`);
		}

		if (batch.state !== 'paused') {
			throw new AppError(
				'E_INVALID_STATE_TRANSITION',
				`Cannot resume batch ${batchId} because its state is '${batch.state}', expected 'paused'`,
			);
		}

		const batchService = createBatchService({
			batchesRepo,
			tasksRepo: tasksRepo ?? ({} as unknown as TasksRepo),
			runsRepo: {} as unknown as RunsRepo,
			unitOfWork: { run: (fn) => fn() },
			clock: { now: getNow },
			bus: deps.bus,
			envelopeFactory: deps.envelopeFactory,
		});

		void batchService.transitionBatch(batchId, 'running', 'human_confirmed_doc_change');

		const updated = batchesRepo.findById(batchId);
		if (!updated) {
			throw new AppError('E_INTERNAL', `Failed to retrieve resumed batch ${batchId}`);
		}

		if (deps.bus && deps.envelopeFactory) {
			deps.bus.publish(
				deps.envelopeFactory.createEnvelope({
					kind: 'batch.advanced',
					payload: {
						batchId: updated.id,
						batchNo: updated.batch_no,
						state: 'running',
						reason: 'human_confirmed_doc_change',
					},
				}),
			);
		}

		return updated;
	}

	function isBatchPaused(batchId: string): boolean {
		if (!batchesRepo) return false;
		const batch = batchesRepo.findById(batchId);
		return batch?.state === 'paused';
	}

	let unsubscribeBus: (() => void) | undefined;
	if (deps.bus) {
		unsubscribeBus = deps.bus.subscribeWithFilter(
			(event) => event.kind === 'system.docs_changed',
			(event) => {
				const payload = event.payload as { docsPath?: string; fingerprint?: string } | undefined;
				if (payload?.docsPath && documentsRepo) {
					const doc = documentsRepo.findByPath(payload.docsPath);
					if (doc) {
						handleDocFingerprintChange({
							docId: doc.id,
							newFingerprint: payload.fingerprint,
							reason: 'system.docs_changed',
						});
					}
				}
			},
		);
	}

	function dispose(): void {
		if (unsubscribeBus) {
			unsubscribeBus();
			unsubscribeBus = undefined;
		}
	}

	return Object.freeze({
		getReviewContext,
		handleDocFingerprintChange,
		pauseRunningBatchesForDoc,
		confirmDocChangeAndResumeBatch,
		isBatchPaused,
		dispose,
	});
}

/**
 * 供 M7 取用的独立 getReviewContext 导出（任务卡要求的产出函数形式）。
 */
export function getReviewContext(
	taskId: string,
	deps: ReviewContextServiceDeps,
	options?: GetReviewContextOptions,
): ReviewContext {
	const service = createReviewContextService(deps);
	try {
		return service.getReviewContext(taskId, options);
	} finally {
		// 每次调用都会新建一个服务实例；注入了 bus 时这里订阅了 system.docs_changed，
		// 不解绑就会每调用一次多一个常驻监听者。
		service.dispose();
	}
}
