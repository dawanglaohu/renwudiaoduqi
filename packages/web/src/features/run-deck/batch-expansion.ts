/**
 * packages/web/src/features/run-deck/batch-expansion.ts
 *
 * 批次树展开集模块级管理（M9-T19 / AC 2, E-284）
 *
 * 规范依据（07 节前端架构与边界 E-284）：
 * - 展开集存放在本模块模块级 Set，左栏批次树与任务列表页完全共用
 * - 首次按 daemon 下发的 defaultExpanded 进行 seed
 * - batch.advanced 到达且 to ∈ {running, wrapping, awaiting_landing, needs_attention} 时并入展开集
 * - 任何事件永不从集合删除元素（除切换文档整体清空与用户手动折叠 toggle）
 * - 手动折叠后，同批若再有上述 advanced 事件到达，仍会自动展开（E-284）
 * - 纯内存暂存，不进 zustand store、不进任何 localStorage 持久化键，刷新后回到 daemon defaultExpanded
 */

import { type EventBus, eventBus } from '../../api/event-bus.ts';

/**
 * 自动展开触发的目标状态枚举（E-284, AC 2）。
 */
export const AUTO_EXPAND_BATCH_STATES = [
	'running',
	'wrapping',
	'awaiting_landing',
	'needs_attention',
] as const;

export type AutoExpandBatchState = (typeof AUTO_EXPAND_BATCH_STATES)[number];

// 模块级单例展开集合与监听器集合
const expandedBatchIds = new Set<string>();
const listeners = new Set<() => void>();

let currentDocId: string | null = null;
let isDocSeeded = false;
let eventBusUnsubscribe: (() => void) | null = null;

function notifyListeners(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// 忽略监听器内部非预期异常
		}
	}
}

/**
 * 获取当前已展开批次 ID 集合快照（只读）。
 */
export function getExpandedBatchIds(): ReadonlySet<string> {
	return expandedBatchIds;
}

/**
 * 订阅批次展开状态变更（供 useSyncExternalStore 使用）。
 */
export function subscribeBatchExpansion(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * 用户手动开合批次（toggle）。
 * 用户手动折叠从集合中移除该批次；手动展开则并入集合。
 */
export function toggleBatchExpansion(batchId: string): void {
	if (!batchId) return;

	if (expandedBatchIds.has(batchId)) {
		expandedBatchIds.delete(batchId);
	} else {
		expandedBatchIds.add(batchId);
	}
	notifyListeners();
}

/**
 * 展开特定批次。
 */
export function expandBatch(batchId: string): void {
	if (!batchId || expandedBatchIds.has(batchId)) return;
	expandedBatchIds.add(batchId);
	notifyListeners();
}

/**
 * 批量展开多个批次。
 */
export function expandBatches(batchIds: readonly string[]): void {
	let changed = false;
	for (const id of batchIds) {
		if (id && !expandedBatchIds.has(id)) {
			expandedBatchIds.add(id);
			changed = true;
		}
	}
	if (changed) {
		notifyListeners();
	}
}

/**
 * 折叠特定批次。
 */
export function collapseBatch(batchId: string): void {
	if (!batchId || !expandedBatchIds.has(batchId)) return;
	expandedBatchIds.delete(batchId);
	notifyListeners();
}

/**
 * 首次根据 daemon 的 defaultExpanded 字段进行 seed 初始化（E-284）。
 * 若切换文档（docId 变更），则清空旧集合并重新 seed。
 * 若本会话已为该文档 seed 过，则只并入新的 defaultExpanded 批次，永不删除用户手动展开的项。
 */
export function seedBatchExpansion(
	batches: readonly { readonly id: string; readonly defaultExpanded?: boolean }[],
	docId?: string,
): void {
	if (docId && docId !== currentDocId) {
		currentDocId = docId;
		expandedBatchIds.clear();
		isDocSeeded = false;
	}

	let changed = false;
	if (!isDocSeeded) {
		for (const b of batches) {
			if (b.defaultExpanded && !expandedBatchIds.has(b.id)) {
				expandedBatchIds.add(b.id);
				changed = true;
			}
		}
		isDocSeeded = true;
	} else {
		// 已 seed 过的文档仅增量补齐标记为 defaultExpanded 的新增批次
		for (const b of batches) {
			if (b.defaultExpanded && !expandedBatchIds.has(b.id)) {
				expandedBatchIds.add(b.id);
				changed = true;
			}
		}
	}

	if (changed) {
		notifyListeners();
	}
}

/**
 * 整体清空展开集合（切换文档或重置会话时使用）。
 */
export function clearBatchExpansion(): void {
	expandedBatchIds.clear();
	currentDocId = null;
	isDocSeeded = false;
	notifyListeners();
}

/**
 * 处理 batch.advanced 事件的 payload（E-284 核心逻辑）。
 * 只要 to ∈ {running, wrapping, awaiting_landing, needs_attention} 立即并入。
 * 任何事件永不删元素，手动折叠后同批事件仍展开。
 */
export function handleBatchAdvancedPayload(payload: {
	readonly batchId?: string;
	readonly to?: string;
	readonly stage?: string;
	readonly state?: string;
	readonly [key: string]: unknown;
}): boolean {
	const batchId = payload.batchId;
	if (!batchId) return false;

	const targetState = payload.to ?? payload.stage ?? payload.state;
	if (!targetState) return false;

	if ((AUTO_EXPAND_BATCH_STATES as readonly string[]).includes(targetState)) {
		if (!expandedBatchIds.has(batchId)) {
			expandedBatchIds.add(batchId);
			notifyListeners();
			return true;
		}
	}
	return false;
}

/**
 * 建立与 eventBus 的订阅连接（监听 milestone 事件）。
 */
export function initBatchExpansionSubscription(bus: EventBus = eventBus): () => void {
	if (eventBusUnsubscribe) {
		eventBusUnsubscribe();
		eventBusUnsubscribe = null;
	}

	eventBusUnsubscribe = bus.subscribeMilestone((envelope) => {
		if (envelope.kind === 'batch.advanced' && envelope.payload) {
			handleBatchAdvancedPayload(
				envelope.payload as Parameters<typeof handleBatchAdvancedPayload>[0],
			);
		}
	});

	return () => {
		if (eventBusUnsubscribe) {
			eventBusUnsubscribe();
			eventBusUnsubscribe = null;
		}
	};
}

// 在浏览器与生产环境下默认自动连接单例 eventBus
if (typeof window !== 'undefined') {
	initBatchExpansionSubscription(eventBus);
}
