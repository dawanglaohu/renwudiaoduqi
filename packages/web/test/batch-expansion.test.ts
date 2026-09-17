import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../src/api/event-bus.ts';
import {
	AUTO_EXPAND_BATCH_STATES,
	clearBatchExpansion,
	collapseBatch,
	expandBatch,
	expandBatches,
	getExpandedBatchIds,
	handleBatchAdvancedPayload,
	initBatchExpansionSubscription,
	seedBatchExpansion,
	subscribeBatchExpansion,
	toggleBatchExpansion,
} from '../src/features/run-deck/batch-expansion.ts';

describe('features/run-deck/batch-expansion (M9-T19, AC 2, E-284, R3)', () => {
	beforeEach(() => {
		clearBatchExpansion();
	});

	// ─── 1. 首次按 defaultExpanded seed ───
	it('seeds initial expansion from defaultExpanded field', () => {
		const batches = [
			{ id: 'batch-1', defaultExpanded: true },
			{ id: 'batch-2', defaultExpanded: false },
			{ id: 'batch-3', defaultExpanded: true },
			{ id: 'batch-4' },
		];

		seedBatchExpansion(batches, 'doc-1');
		const expanded = getExpandedBatchIds();

		expect(expanded.has('batch-1')).toBe(true);
		expect(expanded.has('batch-2')).toBe(false);
		expect(expanded.has('batch-3')).toBe(true);
		expect(expanded.has('batch-4')).toBe(false);
		expect(expanded.size).toBe(2);
	});

	// ─── 2. 手动 toggle 与折叠/展开 ───
	it('toggles expansion state and notifies subscribers', () => {
		const listener = vi.fn();
		const unsub = subscribeBatchExpansion(listener);

		toggleBatchExpansion('batch-1');
		expect(getExpandedBatchIds().has('batch-1')).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);

		toggleBatchExpansion('batch-1');
		expect(getExpandedBatchIds().has('batch-1')).toBe(false);
		expect(listener).toHaveBeenCalledTimes(2);

		expandBatch('batch-2');
		expect(getExpandedBatchIds().has('batch-2')).toBe(true);

		collapseBatch('batch-2');
		expect(getExpandedBatchIds().has('batch-2')).toBe(false);

		expandBatches(['batch-3', 'batch-4']);
		expect(getExpandedBatchIds().has('batch-3')).toBe(true);
		expect(getExpandedBatchIds().has('batch-4')).toBe(true);

		unsub();
	});

	// ─── 3. 切换文档时整体清空并重新 seed ───
	it('clears previous expansion when switching docId', () => {
		seedBatchExpansion([{ id: 'batch-1', defaultExpanded: true }], 'doc-1');
		expect(getExpandedBatchIds().has('batch-1')).toBe(true);

		seedBatchExpansion([{ id: 'batch-2', defaultExpanded: true }], 'doc-2');
		expect(getExpandedBatchIds().has('batch-1')).toBe(false);
		expect(getExpandedBatchIds().has('batch-2')).toBe(true);
	});

	// ─── 4. batch.advanced 到达且 to ∈ {running, wrapping, awaiting_landing, needs_attention} 时自动并入 ───
	it('auto-expands for all target states in AUTO_EXPAND_BATCH_STATES', () => {
		for (const targetState of AUTO_EXPAND_BATCH_STATES) {
			clearBatchExpansion();
			const result = handleBatchAdvancedPayload({
				batchId: `batch-${targetState}`,
				to: targetState,
			});
			expect(result).toBe(true);
			expect(getExpandedBatchIds().has(`batch-${targetState}`)).toBe(true);
		}
	});

	// ─── 5. 任何事件永不删除元素（E-284） ───
	it('never deletes any element upon batch.advanced with done or other states (E-284)', () => {
		expandBatch('batch-kept');
		expect(getExpandedBatchIds().has('batch-kept')).toBe(true);

		// done 状态事件到达
		handleBatchAdvancedPayload({
			batchId: 'batch-kept',
			to: 'done',
		});
		// 仍然保持展开，绝不删除
		expect(getExpandedBatchIds().has('batch-kept')).toBe(true);

		handleBatchAdvancedPayload({
			batchId: 'batch-other',
			to: 'idle',
		});
		expect(getExpandedBatchIds().has('batch-kept')).toBe(true);
	});

	// ─── 6. 手动折叠后同批事件仍展开（E-284） ───
	it('re-expands when a new batch.advanced event arrives even if user manually collapsed it (E-284)', () => {
		expandBatch('batch-1');
		expect(getExpandedBatchIds().has('batch-1')).toBe(true);

		// 用户手动折叠
		toggleBatchExpansion('batch-1');
		expect(getExpandedBatchIds().has('batch-1')).toBe(false);

		// 随后同一批次触发 batch.advanced 状态流转为 running
		handleBatchAdvancedPayload({
			batchId: 'batch-1',
			to: 'running',
		});

		// 必须重新并入展开集
		expect(getExpandedBatchIds().has('batch-1')).toBe(true);
	});

	// ─── 7. 经 subscribeMilestone 到达事件自动触发并入 ───
	it('integrates with EventBus milestone subscription', () => {
		const bus = createEventBus();
		const cleanup = initBatchExpansionSubscription(bus);

		bus.push({
			id: 101,
			ts: new Date().toISOString(),
			runId: null,
			taskId: null,
			scope: 'batch',
			kind: 'batch.advanced',
			seq: 1,
			actorDeviceId: null,
			payload: {
				batchId: 'batch-milestone-1',
				to: 'awaiting_landing',
			},
		});

		expect(getExpandedBatchIds().has('batch-milestone-1')).toBe(true);

		cleanup();
	});

	// ─── 8. R3: useSyncExternalStore 快照不可变引用更新，确保每次变动触发消费者重渲染 ───
	it('updates snapshot reference on toggleBatchExpansion so useSyncExternalStore re-renders (R3)', () => {
		const initialSnapshot = getExpandedBatchIds();
		const listener = vi.fn();
		const unsub = subscribeBatchExpansion(listener);

		toggleBatchExpansion('batch-rerender');
		const nextSnapshot = getExpandedBatchIds();

		// 快照对象引用必须变化，否则 Object.is 判定相等将吞掉重渲染
		expect(nextSnapshot).not.toBe(initialSnapshot);
		expect(nextSnapshot.has('batch-rerender')).toBe(true);
		expect(listener).toHaveBeenCalled();

		unsub();
	});

	it('updates snapshot reference on batch.advanced so useSyncExternalStore re-renders (R3)', () => {
		const bus = createEventBus();
		const cleanup = initBatchExpansionSubscription(bus);
		const initialSnapshot = getExpandedBatchIds();
		const listener = vi.fn();
		const unsub = subscribeBatchExpansion(listener);

		bus.push({
			id: 202,
			ts: new Date().toISOString(),
			runId: null,
			taskId: null,
			scope: 'batch',
			kind: 'batch.advanced',
			seq: 2,
			actorDeviceId: null,
			payload: {
				batchId: 'batch-rerender-advanced',
				to: 'running',
			},
		});

		const nextSnapshot = getExpandedBatchIds();
		expect(nextSnapshot).not.toBe(initialSnapshot);
		expect(nextSnapshot.has('batch-rerender-advanced')).toBe(true);
		expect(listener).toHaveBeenCalled();

		unsub();
		cleanup();
	});
});
