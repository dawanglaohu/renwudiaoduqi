import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus, eventBus } from '../src/api/event-bus.ts';
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
import { useBatchTree } from '../src/features/run-deck/use-batch-tree.ts';
import { useTaskList } from '../src/features/task-list/use-task-list.ts';

// ─── DOM 模拟环境（用于挂载真实消费者并验证 React 实际重渲染，R3） ───
class TestDOMElement {
	nodeType = 1;
	tagName: string;
	attributes: Record<string, string> = {};
	childNodes: (TestDOMElement | { nodeType: 3; textContent: string })[] = [];
	parentNode: TestDOMElement | null = null;
	listeners: Record<string, ((e: unknown) => void)[]> = {};

	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
	}

	setAttribute(k: string, v: unknown) {
		this.attributes[k] = String(v);
	}
	getAttribute(k: string): string | null {
		return this.attributes[k] ?? null;
	}
	hasAttribute(k: string): boolean {
		return k in this.attributes;
	}
	removeAttribute(k: string) {
		delete this.attributes[k];
	}
	appendChild(c: TestDOMElement | { nodeType: 3; textContent: string }) {
		if ('parentNode' in c) c.parentNode = this;
		this.childNodes.push(c);
		return c;
	}
	removeChild(c: TestDOMElement | { nodeType: 3; textContent: string }) {
		const idx = this.childNodes.indexOf(c);
		if (idx >= 0) {
			if ('parentNode' in c) c.parentNode = null;
			this.childNodes.splice(idx, 1);
		}
		return c;
	}
	insertBefore(
		c: TestDOMElement | { nodeType: 3; textContent: string },
		ref: TestDOMElement | { nodeType: 3; textContent: string },
	) {
		const idx = this.childNodes.indexOf(ref);
		if (idx >= 0) this.childNodes.splice(idx, 0, c);
		else this.childNodes.push(c);
		if ('parentNode' in c) c.parentNode = this;
		return c;
	}
	addEventListener(t: string, f: (e: unknown) => void) {
		if (!this.listeners[t]) this.listeners[t] = [];
		this.listeners[t].push(f);
	}
	removeEventListener(t: string, f: (e: unknown) => void) {
		if (!this.listeners[t]) return;
		this.listeners[t] = this.listeners[t].filter((x) => x !== f);
	}
	dispatchEvent(ev: {
		type: string;
		bubbles?: boolean;
		target?: unknown;
		currentTarget?: unknown;
	}) {
		ev.target = ev.target || this;
		ev.currentTarget = this;
		for (const f of this.listeners[ev.type] || []) f(ev);
		if (this.parentNode && ev.bubbles) this.parentNode.dispatchEvent(ev);
	}
	querySelector(sel: string): TestDOMElement | null {
		const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="?([^"]+)"?)?\]$/);
		if (attrMatch) {
			const [, attr, val] = attrMatch;
			if (attr) {
				if (val !== undefined) {
					if (this.getAttribute(attr) === val) return this;
				} else if (this.hasAttribute(attr)) {
					return this;
				}
			}
		}
		for (const child of this.childNodes) {
			if ('nodeType' in child && child.nodeType === 1) {
				const found = (child as TestDOMElement).querySelector(sel);
				if (found) return found;
			}
		}
		return null;
	}
}

function setupMockDom() {
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	(globalThis as unknown as { HTMLIFrameElement: unknown }).HTMLIFrameElement = class {};
	(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = class {};
	(globalThis as unknown as { Element: unknown }).Element = class {};
	(globalThis as unknown as { Node: unknown }).Node = class {};

	const doc = {
		nodeType: 9,
		nodeName: '#document',
		createElement: (tag: string) => new TestDOMElement(tag),
		createTextNode: (text: string) => ({ nodeType: 3 as const, textContent: text }),
		addEventListener: () => {},
		removeEventListener: () => {},
		defaultView: globalThis,
	};
	(globalThis as unknown as { window: unknown }).window = globalThis;
	(globalThis as unknown as { document: unknown }).document = doc;

	const container = doc.createElement('div');
	(container as unknown as { ownerDocument: unknown }).ownerDocument = doc;
	return { container, root: createRoot(container as unknown as HTMLElement) };
}

describe('features/run-deck/batch-expansion (M9-T19, AC 2, E-284, R3)', () => {
	let busCleanup: (() => void) | null = null;

	beforeEach(() => {
		clearBatchExpansion();
		busCleanup?.();
		busCleanup = initBatchExpansionSubscription(eventBus);
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

	// ─── 9. R3 核心：挂载真实 useBatchTree 消费者，验证 toggle 与 batch.advanced 触发实际 React 重渲染与 DOM 输出变动 ───
	it('triggers actual React re-renders and DOM output changes for mounted useBatchTree consumer (R3)', async () => {
		const { container, root } = setupMockDom();
		let renderCount = 0;
		let lastRenderedBatchIds: string[] = [];

		const sampleBatches = [
			{ id: 'batch-c1', batchNo: 1, defaultExpanded: false },
			{ id: 'batch-c2', batchNo: 2, defaultExpanded: false },
		];

		function BatchTreeConsumer() {
			const { expandedIds } = useBatchTree({ batches: sampleBatches });
			renderCount += 1;
			lastRenderedBatchIds = Array.from(expandedIds).sort();

			return createElement('div', {
				'data-component': 'batch-tree-consumer',
				'data-render-count': renderCount,
				'data-expanded-ids': lastRenderedBatchIds.join(','),
			});
		}

		try {
			await act(async () => {
				root.render(createElement(BatchTreeConsumer));
			});

			const el = container.querySelector('[data-component="batch-tree-consumer"]');
			expect(el).not.toBeNull();
			const initialCount = renderCount;
			expect(el?.getAttribute('data-expanded-ids')).toBe('');

			// 1. 用户点击开合 toggleBatch
			await act(async () => {
				toggleBatchExpansion('batch-c1');
			});

			// 必须触发 React 实际重渲染且输出已变更！
			expect(renderCount).toBe(initialCount + 1);
			expect(el?.getAttribute('data-render-count')).toBe(String(initialCount + 1));
			expect(el?.getAttribute('data-expanded-ids')).toBe('batch-c1');
			expect(lastRenderedBatchIds).toEqual(['batch-c1']);

			// 2. 真实 milestone 事件 batch.advanced 到达
			await act(async () => {
				eventBus.push({
					id: 303,
					ts: new Date().toISOString(),
					runId: null,
					taskId: null,
					scope: 'batch',
					kind: 'batch.advanced',
					seq: 1,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-c2',
						to: 'running',
					},
				});
			});

			// 必须触发下一次重渲染，且输出包含 batch-c1 与 batch-c2！
			expect(renderCount).toBe(initialCount + 2);
			expect(el?.getAttribute('data-render-count')).toBe(String(initialCount + 2));
			expect(el?.getAttribute('data-expanded-ids')).toBe('batch-c1,batch-c2');
			expect(lastRenderedBatchIds).toEqual(['batch-c1', 'batch-c2']);

			// 3. 到达非自动展开状态（例如 done），只增不减（E-284）
			await act(async () => {
				eventBus.push({
					id: 304,
					ts: new Date().toISOString(),
					runId: null,
					taskId: null,
					scope: 'batch',
					kind: 'batch.advanced',
					seq: 2,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-c1',
						to: 'done',
					},
				});
			});

			// 不删除任何元素，保持已展开项
			expect(lastRenderedBatchIds).toEqual(['batch-c1', 'batch-c2']);
		} finally {
			await act(async () => {
				root.unmount();
			});
		}
	});

	// ─── 10. R3 核心：挂载真实 useTaskList 消费者，验证 toggle 与 batch.advanced 触发实际 React 重渲染与 DOM 输出变动 ───
	it('triggers actual React re-renders and DOM output changes for mounted useTaskList consumer (R3)', async () => {
		const { container, root } = setupMockDom();
		let taskListRenderCount = 0;
		let taskListExpandedIds: string[] = [];

		const sampleBatches = [
			{ id: 'batch-t1', batchNo: 1, defaultExpanded: true },
			{ id: 'batch-t2', batchNo: 2, defaultExpanded: false },
		];

		function TaskListConsumer() {
			const { expandedIds } = useTaskList({ batches: sampleBatches, docId: 'doc-tl-1' });
			taskListRenderCount += 1;
			taskListExpandedIds = Array.from(expandedIds).sort();

			return createElement('div', {
				'data-component': 'task-list-consumer',
				'data-render-count': taskListRenderCount,
				'data-expanded-ids': taskListExpandedIds.join(','),
			});
		}

		try {
			await act(async () => {
				root.render(createElement(TaskListConsumer));
			});

			const el = container.querySelector('[data-component="task-list-consumer"]');
			expect(el).not.toBeNull();
			const initialCount = taskListRenderCount;
			expect(el?.getAttribute('data-expanded-ids')).toBe('batch-t1');

			// 1. 用户点击开合 toggleBatch
			await act(async () => {
				toggleBatchExpansion('batch-t2');
			});

			// 必须触发 React 实际重渲染且输出已变更！
			expect(taskListRenderCount).toBe(initialCount + 1);
			expect(el?.getAttribute('data-render-count')).toBe(String(initialCount + 1));
			expect(el?.getAttribute('data-expanded-ids')).toBe('batch-t1,batch-t2');
			expect(taskListExpandedIds).toEqual(['batch-t1', 'batch-t2']);

			// 2. 真实 milestone 事件 batch.advanced 到达
			await act(async () => {
				eventBus.push({
					id: 404,
					ts: new Date().toISOString(),
					runId: null,
					taskId: null,
					scope: 'batch',
					kind: 'batch.advanced',
					seq: 3,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-t3',
						to: 'awaiting_landing',
					},
				});
			});

			// 必须触发下一次重渲染，且输出包含新展开的 batch-t3！
			expect(taskListRenderCount).toBe(initialCount + 2);
			expect(el?.getAttribute('data-render-count')).toBe(String(initialCount + 2));
			expect(el?.getAttribute('data-expanded-ids')).toBe('batch-t1,batch-t2,batch-t3');
			expect(taskListExpandedIds).toEqual(['batch-t1', 'batch-t2', 'batch-t3']);
		} finally {
			await act(async () => {
				root.unmount();
			});
		}
	});
});
