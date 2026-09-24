/**
 * packages/web/src/features/run-deck/batch-expansion.ts
 *
 * 批次树展开集模块级管理（M9-T19 / AC 2, E-284, 返工 R3）
 *
 * 规范依据（07 节前端架构与边界 E-284）：
 * - 展开集存放在本模块模块级 Set，左栏批次树与任务列表页完全共用
 * - 首次按 daemon 下发的 defaultExpanded 进行 seed
 * - batch.advanced 到达且 to ∈ {running, wrapping, awaiting_landing, needs_attention} 时并入展开集
 * - 任何事件永不从集合删除元素（除切换文档整体清空与用户手动折叠 toggle）；不提供独立的 collapse 入口
 * - 手动折叠后，同批若再有上述 advanced 事件到达，仍会自动展开（E-284）
 * - 订阅快照是整数 version（07 节：getSnapshot 只返回数字），集合本身经 getExpandedBatchIds() 另行读取；
 *   每次有效变更同时生成新的只读 Set 快照，两种读法都能让 useSyncExternalStore 触发重渲染（R3）
 * - 纯内存暂存，不进 zustand store、不进任何 localStorage 持久化键，刷新后回到 daemon defaultExpanded
 */

import type { BatchDto } from '@agent-scheduler/shared/api/batches';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { type EventBus, eventBus } from '../../api/event-bus.ts';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';

/**
 * 将快照数据映射为 BatchTreeItem（R1, R5）。
 * 纯粹消费 daemon 原样字段，前端绝不推导、伪造计数或展开状态。
 */
export function mapSnapshotToBatches(
	snapshot: SnapshotResponse,
	roundByRunId?: ReadonlyMap<string, number>,
	runs: readonly RunDto[] = snapshot.runs ?? [],
	batchDetails: readonly BatchDto[] = [],
): readonly BatchTreeItem[] {
	const rawBatches = (snapshot.batches ?? []) as readonly BatchDto[];
	const rawTasks = (snapshot.tasks ?? []) as readonly TaskDto[];
	const detailsById = new Map(batchDetails.map((batch) => [batch.id, batch]));
	const latestWrapupByBatch = new Map<string, RunDto>();
	for (const run of runs) {
		if (run.kind !== 'wrapup' || !run.batchId) continue;
		const previous = latestWrapupByBatch.get(run.batchId);
		if (!previous || run.attemptNo > previous.attemptNo) {
			latestWrapupByBatch.set(run.batchId, run);
		}
	}

	return rawBatches.map((b) => {
		const wrapup = latestWrapupByBatch.get(b.id);
		const round = wrapup ? roundByRunId?.get(wrapup.id) : undefined;
		return {
			...b,
			...detailsById.get(b.id),
			tasks: rawTasks.filter((t) => t.batchId === b.id),
			wrapupRow: wrapup
				? {
						runId: wrapup.id,
						state: wrapup.state,
						round,
						title: round ? `批次收口 · 第 ${round} 轮` : '批次收口',
					}
				: null,
		};
	});
}

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

// 模块级单例展开集合、只读快照与整数 version
const expandedBatchIds = new Set<string>();
const seededBatchIds = new Set<string>();
let expandedSnapshot: ReadonlySet<string> = new Set<string>();
let expansionVersion = 0;
const listeners = new Set<() => void>();

let currentDocId: string | null = null;
let eventBusUnsubscribe: (() => void) | null = null;

function notifyListeners(): void {
	// R3: 每次集合产生有效变动，version 自增并重新生成不可变 Set 快照
	expansionVersion += 1;
	expandedSnapshot = new Set(expandedBatchIds);
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// 忽略监听器内部非预期异常
		}
	}
}

/**
 * 获取当前已展开批次 ID 集合快照（只读，具有稳定的引用，每次变动返回新引用，R3）。
 */
export function getExpandedBatchIds(): ReadonlySet<string> {
	return expandedSnapshot;
}

/**
 * 展开集的整数 version：useSyncExternalStore 的 getSnapshot 只返回这个数字（07 节）。
 */
export function getBatchExpansionVersion(): number {
	return expansionVersion;
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
 * 首次根据 daemon 的 defaultExpanded 字段进行 seed 初始化（E-284）。
 * 若切换文档（docId 变更），则清空旧集合并重新 seed。
 * 若本会话已为该文档 seed 过，则只并入新的 defaultExpanded 批次，永不删除用户手动展开的项。
 */
export function seedBatchExpansion(
	batches: readonly { readonly id: string; readonly defaultExpanded?: boolean }[],
	docId?: string,
): void {
	let changed = false;
	if (docId && docId !== currentDocId) {
		currentDocId = docId;
		changed = expandedBatchIds.size > 0;
		expandedBatchIds.clear();
		seededBatchIds.clear();
	}

	for (const b of batches) {
		// Only newly observed batches take their initial default. A later snapshot must not
		// reopen a batch that the user manually collapsed.
		if (!seededBatchIds.has(b.id)) {
			seededBatchIds.add(b.id);
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
	seededBatchIds.clear();
	currentDocId = null;
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
