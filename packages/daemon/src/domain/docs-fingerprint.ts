export interface TaskContractHashItem {
	readonly id: string;
	readonly contractHash: string;
}

export type DocsFingerprintHasher = (canonicalPayload: string) => string;

/**
 * 对任务列表进行跨平台确定性规范化（canonicalization）。
 * 按任务 ID 的二进制 UTF-16 序升序排序，输出唯一的 JSON 规范串。
 * 绝不包含 generated、mtime 或其他非契约元数据（E-17、E-79）。
 */
export function canonicalizeDocsFingerprintPayload(
	tasks: readonly TaskContractHashItem[] | Iterable<TaskContractHashItem>,
): string {
	const items = Array.from(tasks).map((item) => [item.id, item.contractHash] as const);
	items.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(items);
}

/**
 * 使用注入的哈希函数对规范化载荷计算指纹。
 * 调用方拥有具体哈希实现，domain 只负责确定性规范化。
 */
export function computeDocsFingerprint(
	tasks: readonly TaskContractHashItem[] | Iterable<TaskContractHashItem>,
	hasher: DocsFingerprintHasher,
): string {
	const payload = canonicalizeDocsFingerprintPayload(tasks);
	return hasher(payload);
}

/**
 * 任务在当前文档或任务表中的输入结构（用于比对）。
 */
export interface TaskDocComparisonInput {
	readonly id: string;
	readonly taskKey: string;
	readonly inputText?: string | null;
	readonly outputText?: string | null;
	readonly acceptText?: string | null;
	readonly implPrompt?: string | null;
	readonly reviewPrompt?: string | null;
	readonly contractHash: string;
	readonly taskPathsJson?: string | null;
	readonly isRemovedFromDoc?: boolean | number;
}

/**
 * 派发快照在比对时所需的字段结构（只读）。
 */
export interface DispatchSnapshotComparisonInput {
	readonly id: string;
	readonly taskId: string;
	readonly inputText?: string | null;
	readonly outputText?: string | null;
	readonly acceptText?: string | null;
	readonly implPrompt?: string | null;
	readonly reviewPrompt?: string | null;
	readonly contractHash: string;
	readonly taskPathsJson?: string | null;
	readonly launchSpecJson?: string | null;
	readonly createdAt: string;
}

/**
 * 任务与最近一次派发快照比对产生的三个变更标记及详细结果（决策 13、E-18、E-19、E-77、E-78、E-80）。
 */
export interface TaskDiffResult {
	readonly taskId: string;
	readonly taskKey: string;
	/** 标记 1：任务已从文档消失（E-18、E-77） */
	readonly isRemovedFromDoc: boolean;
	/** 标记 2：验收标准／依据已变（input/output/accept 任一改变，E-19、E-78） */
	readonly hasAcceptChanged: boolean;
	/** 标记 3：提示词或契约哈希已变（impl_prompt/review_prompt/contract_hash 任一改变，E-77、E-78） */
	readonly hasPromptChanged: boolean;
	/** 细分指标：accept 文本是否改变（用于 E-78 验收卡片展示） */
	readonly isAcceptTextChanged: boolean;
	/** 细分指标：input 文本是否改变 */
	readonly isInputTextChanged: boolean;
	/** 细分指标：output 文本是否改变 */
	readonly isOutputTextChanged: boolean;
	/** 细分指标：实施提示词是否改变 */
	readonly isImplPromptChanged: boolean;
	/** 细分指标：审查提示词是否改变 */
	readonly isReviewPromptChanged: boolean;
	/** 细分指标：契约哈希是否改变（含范围、条款等变更） */
	readonly isContractHashChanged: boolean;
	/** 是否存在任何变更（isRemovedFromDoc || hasAcceptChanged || hasPromptChanged） */
	readonly hasAnyChange: boolean;
	/** 最近一次派发快照 ID（未派发过为 null） */
	readonly latestSnapshotId: string | null;
	/** 快照创建时间 ISO8601（未派发过为 null） */
	readonly snapshotCreatedAt: string | null;
}

/**
 * 文档变更横幅数据结构（决策 13、E-19 呈现侧、E-77、E-78）。
 */
export interface DocChangeBannerData {
	readonly docId: string;
	readonly hasChanges: boolean;
	readonly totalTasksCount: number;
	readonly affectedTaskCount: number;
	readonly removedTaskCount: number;
	readonly acceptChangedCount: number;
	readonly promptChangedCount: number;
	readonly affectedTaskIds: readonly string[];
	readonly removedTaskIds: readonly string[];
	readonly acceptChangedTaskIds: readonly string[];
	readonly promptChangedTaskIds: readonly string[];
	readonly tasks: readonly TaskDiffResult[];
}

export type TaskDiffFilter = 'all' | 'removed' | 'accept_changed' | 'prompt_changed';

export interface TaskDispatchEligibility {
	readonly canDispatch: boolean;
	/**
	 * 阻断原因分类，供调用方选择错误码：
	 * removed_from_doc → E_TASK_REMOVED_FROM_DOC；contract_not_ready → E_DOC_CONTRACT_PENDING。
	 */
	readonly blockReason?: 'removed_from_doc' | 'contract_not_ready';
	readonly reason?: string;
}

function normalizeComparableText(text: string | null | undefined): string {
	return text ?? '';
}

/**
 * 将任务当前文档状态与最近一次派发快照进行逐字符比对，产出三个布尔标记（E-19、E-77、E-78、E-80）。
 * 1. 任务已消失：新文档中不存在该任务；
 * 2. 验收标准已变：input/output/accept 任一段发生逐字符变化；
 * 3. 提示词已变：impl_prompt/review_prompt 发生逐字符变化，或 contract_hash 变化（涵盖范围/条款变化）。
 * 若从未派发过（latestSnapshot=null），验收与提示词标记恒为 false。
 */
export function compareTaskWithSnapshot(
	task: TaskDocComparisonInput,
	latestSnapshot: DispatchSnapshotComparisonInput | null,
	isExplicitlyRemoved = false,
): TaskDiffResult {
	const isRemovedFromDoc = Boolean(
		isExplicitlyRemoved || task.isRemovedFromDoc === 1 || task.isRemovedFromDoc === true,
	);

	if (!latestSnapshot) {
		return Object.freeze({
			taskId: task.id,
			taskKey: task.taskKey,
			isRemovedFromDoc,
			hasAcceptChanged: false,
			hasPromptChanged: false,
			isAcceptTextChanged: false,
			isInputTextChanged: false,
			isOutputTextChanged: false,
			isImplPromptChanged: false,
			isReviewPromptChanged: false,
			isContractHashChanged: false,
			hasAnyChange: isRemovedFromDoc,
			latestSnapshotId: null,
			snapshotCreatedAt: null,
		});
	}

	const isAcceptTextChanged =
		normalizeComparableText(task.acceptText) !== normalizeComparableText(latestSnapshot.acceptText);
	const isInputTextChanged =
		normalizeComparableText(task.inputText) !== normalizeComparableText(latestSnapshot.inputText);
	const isOutputTextChanged =
		normalizeComparableText(task.outputText) !== normalizeComparableText(latestSnapshot.outputText);

	const isImplPromptChanged =
		normalizeComparableText(task.implPrompt) !== normalizeComparableText(latestSnapshot.implPrompt);
	const isReviewPromptChanged =
		normalizeComparableText(task.reviewPrompt) !==
		normalizeComparableText(latestSnapshot.reviewPrompt);
	const isContractHashChanged = task.contractHash !== latestSnapshot.contractHash;

	const hasAcceptChanged = isAcceptTextChanged || isInputTextChanged || isOutputTextChanged;
	const hasPromptChanged = isImplPromptChanged || isReviewPromptChanged || isContractHashChanged;
	const hasAnyChange = isRemovedFromDoc || hasAcceptChanged || hasPromptChanged;

	return Object.freeze({
		taskId: task.id,
		taskKey: task.taskKey,
		isRemovedFromDoc,
		hasAcceptChanged,
		hasPromptChanged,
		isAcceptTextChanged,
		isInputTextChanged,
		isOutputTextChanged,
		isImplPromptChanged,
		isReviewPromptChanged,
		isContractHashChanged,
		hasAnyChange,
		latestSnapshotId: latestSnapshot.id,
		snapshotCreatedAt: latestSnapshot.createdAt,
	});
}

/**
 * 汇总当前文档所有任务与最新快照的比对结果，生成横幅数据与统计清单（E-19、E-77、E-78）。
 */
export function computeDocDiffBanner(
	docId: string,
	tasks: readonly TaskDocComparisonInput[],
	latestSnapshotsMap: ReadonlyMap<string, DispatchSnapshotComparisonInput>,
	activeTaskKeys?: readonly string[],
): DocChangeBannerData {
	const activeKeysSet = activeTaskKeys ? new Set(activeTaskKeys) : null;
	const diffResults: TaskDiffResult[] = [];

	const affectedTaskIds: string[] = [];
	const removedTaskIds: string[] = [];
	const acceptChangedTaskIds: string[] = [];
	const promptChangedTaskIds: string[] = [];

	for (const task of tasks) {
		const isExplicitlyRemoved = activeKeysSet !== null && !activeKeysSet.has(task.taskKey);
		const snapshot = latestSnapshotsMap.get(task.id) ?? null;
		const result = compareTaskWithSnapshot(task, snapshot, isExplicitlyRemoved);
		diffResults.push(result);

		if (result.hasAnyChange) {
			affectedTaskIds.push(result.taskId);
		}
		if (result.isRemovedFromDoc) {
			removedTaskIds.push(result.taskId);
		}
		if (result.hasAcceptChanged) {
			acceptChangedTaskIds.push(result.taskId);
		}
		if (result.hasPromptChanged) {
			promptChangedTaskIds.push(result.taskId);
		}
	}

	return Object.freeze({
		docId,
		hasChanges: affectedTaskIds.length > 0,
		totalTasksCount: tasks.length,
		affectedTaskCount: affectedTaskIds.length,
		removedTaskCount: removedTaskIds.length,
		acceptChangedCount: acceptChangedTaskIds.length,
		promptChangedCount: promptChangedTaskIds.length,
		affectedTaskIds: Object.freeze(affectedTaskIds),
		removedTaskIds: Object.freeze(removedTaskIds),
		acceptChangedTaskIds: Object.freeze(acceptChangedTaskIds),
		promptChangedTaskIds: Object.freeze(promptChangedTaskIds),
		tasks: Object.freeze(diffResults),
	});
}

/**
 * 过滤受影响的任务列表（E-77、E-78）。
 */
export function filterAffectedTasks(
	tasks: readonly TaskDiffResult[],
	filter: TaskDiffFilter = 'all',
): readonly TaskDiffResult[] {
	switch (filter) {
		case 'removed':
			return Object.freeze(tasks.filter((t) => t.isRemovedFromDoc));
		case 'accept_changed':
			return Object.freeze(tasks.filter((t) => t.hasAcceptChanged));
		case 'prompt_changed':
			return Object.freeze(tasks.filter((t) => t.hasPromptChanged));
		default:
			return Object.freeze(tasks.filter((t) => t.hasAnyChange));
	}
}

/**
 * 检查任务是否具备派发资格。
 * 任务从文档移除后禁止再次派发（E-18、E-77）。
 */
export function checkTaskDispatchEligibility(task: {
	readonly isRemovedFromDoc?: boolean | number;
	readonly is_removed_from_doc?: boolean | number;
	readonly isContractReady?: boolean | number;
	readonly is_contract_ready?: boolean | number;
}): TaskDispatchEligibility {
	const isRemoved =
		task.isRemovedFromDoc === 1 ||
		task.isRemovedFromDoc === true ||
		task.is_removed_from_doc === 1 ||
		task.is_removed_from_doc === true;

	if (isRemoved) {
		return Object.freeze({
			canDispatch: false,
			blockReason: 'removed_from_doc',
			reason: 'Task has been removed from document (E-18, E-77)',
		});
	}

	const isReady =
		task.isContractReady !== undefined
			? task.isContractReady === 1 || task.isContractReady === true
			: task.is_contract_ready !== undefined
				? task.is_contract_ready === 1 || task.is_contract_ready === true
				: true;

	if (!isReady) {
		return Object.freeze({
			canDispatch: false,
			blockReason: 'contract_not_ready',
			reason: 'Task contract is not ready for dispatch (E-82)',
		});
	}
	return Object.freeze({ canDispatch: true });
}
