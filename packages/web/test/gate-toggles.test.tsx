/**
 * packages/web/test/gate-toggles.test.tsx
 *
 * 顶栏闸门开关组件与容器测试（M9-T19 / AC 6, E-299, R4）
 */

import { ROUTES } from '@agent-scheduler/shared/api/routes';
import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { GateToggles } from '../src/components/gate-toggles.tsx';
import { GateTogglesContainer } from '../src/features/run-deck/gate-toggles-container.tsx';

// ─── 简易 DOM 环境模拟（用于真实挂载与交互点击测试，R4） ───
class TestDOMElement {
	nodeType = 1;
	tagName: string;
	attributes: Record<string, string> = {};
	childNodes: (TestDOMElement | { nodeType: 3; textContent: string })[] = [];
	parentNode: TestDOMElement | null = null;
	listeners: Record<string, ((e: unknown) => void)[]> = {};
	style: Record<string, string> = {};

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

	addEventListener(type: string, fn: (e: unknown) => void) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(fn);
	}

	removeEventListener(type: string, fn: (e: unknown) => void) {
		if (!this.listeners[type]) return;
		this.listeners[type] = this.listeners[type].filter((l) => l !== fn);
	}

	dispatchEvent(event: {
		type: string;
		bubbles?: boolean;
		target?: unknown;
		currentTarget?: unknown;
	}) {
		event.target = event.target || this;
		event.currentTarget = this;
		const list = this.listeners[event.type] || [];
		for (const fn of list) fn.call(this, event);
		if (this.parentNode && event.bubbles) {
			this.parentNode.dispatchEvent(event);
		}
	}

	click() {
		this.dispatchEvent({ type: 'click', bubbles: true });
	}

	querySelector(sel: string): TestDOMElement | null {
		const isTag = /^[a-zA-Z0-9]+$/.test(sel);
		if (isTag && this.tagName.toLowerCase() === sel.toLowerCase()) {
			return this;
		}
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

	querySelectorAll(sel: string): TestDOMElement[] {
		const results: TestDOMElement[] = [];
		const isTag = /^[a-zA-Z0-9]+$/.test(sel);
		if (isTag && this.tagName.toLowerCase() === sel.toLowerCase()) {
			results.push(this);
		}
		const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="?([^"]+)"?)?\]$/);
		if (attrMatch) {
			const [, attr, val] = attrMatch;
			if (attr) {
				if (val !== undefined) {
					if (this.getAttribute(attr) === val) results.push(this);
				} else if (this.hasAttribute(attr)) {
					results.push(this);
				}
			}
		}
		for (const child of this.childNodes) {
			if ('nodeType' in child && child.nodeType === 1) {
				results.push(...(child as TestDOMElement).querySelectorAll(sel));
			}
		}
		return results;
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

describe('components/gate-toggles (M9-T19, AC 6, E-299, R4)', () => {
	const initialValues: GateSettings = {
		dispatch: 'manual',
		review: 'manual',
		landing: 'manual',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ─── 1. 三个开关同一形态，第三个不再置灰 ───
	it('renders three switches with identical morphology, and landing switch is active (E-299)', () => {
		const html = renderToStaticMarkup(createElement(GateToggles, { value: initialValues }));

		expect(html).toContain('派发前');
		expect(html).toContain('审查前');
		expect(html).toContain('落地前');

		// 三个开关均存在
		expect(html).toContain('data-gate-toggle="dispatch"');
		expect(html).toContain('data-gate-toggle="review"');
		expect(html).toContain('data-gate-toggle="landing"');

		// 落地前开关未被 disabled / 置灰
		expect(html).not.toContain('disabled=""');
	});

	// ─── 2. 落地开关切到自动时不弹 dialog，常驻一行提示 ───
	it('renders permanent notice when landing is auto without popping dialog (E-299)', () => {
		const autoLandingValues: GateSettings = {
			dispatch: 'manual',
			review: 'manual',
			landing: 'auto',
		};

		const html = renderToStaticMarkup(createElement(GateToggles, { value: autoLandingValues }));

		// 包含常驻说明文本
		expect(html).toContain('审查 pass 后直接标记已验收，仍不执行任何 git 操作');
		expect(html).toContain('data-testid="landing-auto-note"');
		// 严禁包含 dialog / modal / portal
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('modal');
	});

	// ─── 3. 落地开关为 manual 时不渲染常驻提示 ───
	it('does not render landing auto note when landing is manual', () => {
		const html = renderToStaticMarkup(createElement(GateToggles, { value: initialValues }));

		expect(html).not.toContain('审查 pass 后直接标记已验收，仍不执行任何 git 操作');
		expect(html).not.toContain('data-testid="landing-auto-note"');
	});

	// ─── 4. onChange 提交全量三值 ───
	it('calls onChange with all 3 gate values on toggle', () => {
		const handleChange = vi.fn();

		const toggles = GateToggles({
			value: initialValues,
			onChange: handleChange,
		});

		expect(toggles.props['data-component']).toBe('gate-toggles');
	});

	// ─── 5. Shared 契约路由一致性 ───
	it('uses shared ROUTES definitions for GET and PATCH /api/v1/settings/gates (R4)', () => {
		const getRoute = ROUTES.find((r) => r.method === 'GET' && r.path === '/api/v1/settings/gates');
		const patchRoute = ROUTES.find(
			(r) => r.method === 'PATCH' && r.path === '/api/v1/settings/gates',
		);

		expect(getRoute).toBeDefined();
		expect(getRoute?.resType).toBe('UpdateGateSettingsResponse');
		expect(patchRoute).toBeDefined();
		expect(patchRoute?.reqType).toBe('UpdateGateSettingsBody');
		expect(patchRoute?.resType).toBe('UpdateGateSettingsResponse');
	});

	// ─── 6. R4 核心：真实点击全量三值 PATCH，响应后仍 pending 且 DOM 不翻转，等 settings.gates_changed 回流翻转 ───
	it('PATCH sends full 3 values, remains pending without DOM flip after PATCH resolution, and flips only on settings.gates_changed (R4, E-299)', async () => {
		const { container, root } = setupMockDom();

		let patchPayload: GateSettings | null = null;
		const patcher = vi.fn(async (body: GateSettings) => {
			patchPayload = body;
			return { gates: body };
		});

		const initialGates: GateSettings = {
			dispatch: 'manual',
			review: 'auto',
			landing: 'manual',
		};

		await act(async () => {
			root.render(
				createElement(GateTogglesContainer, {
					initialGates,
					patcher,
				}),
			);
		});

		const togglesDiv = container.querySelector('[data-component="gate-toggles"]');
		expect(togglesDiv).not.toBeNull();
		expect(togglesDiv?.getAttribute('data-pending')).toBe('false');

		// 找到落地前开关的「自动」按钮
		const landingToggleGroup = container.querySelector('[data-gate-toggle="landing"]');
		expect(landingToggleGroup).not.toBeNull();
		const buttons = landingToggleGroup?.querySelectorAll('button') ?? [];
		expect(buttons.length).toBe(2);
		const manualBtn = buttons[0];
		const autoBtn = buttons[1];
		expect(manualBtn?.getAttribute('data-state')).toBe('active');
		expect(autoBtn?.getAttribute('data-state')).toBe('inactive');

		// 点击「自动」
		await act(async () => {
			autoBtn?.click();
		});

		// 验证 1: PATCH 必须携带全量三值（dispatch: 'manual', review: 'auto', landing: 'auto'）
		expect(patcher).toHaveBeenCalledTimes(1);
		expect(patchPayload).toEqual({
			dispatch: 'manual',
			review: 'auto',
			landing: 'auto',
		});

		// 验证 2: PATCH 响应后，必须处于 pending 状态，且 DOM 绝不提前翻转！
		expect(togglesDiv?.getAttribute('data-pending')).toBe('true');
		expect(manualBtn?.getAttribute('data-state')).toBe('active');
		expect(autoBtn?.getAttribute('data-state')).toBe('inactive');
		// 落地提示也不提前呈现
		expect(container.querySelector('[data-testid="landing-auto-note"]')).toBeNull();

		// 验证 3: 事件回流 settings.gates_changed 到达
		await act(async () => {
			eventBus.push({
				id: 888,
				ts: new Date().toISOString(),
				runId: null,
				taskId: null,
				scope: 'settings',
				kind: 'settings.gates_changed',
				seq: 1,
				actorDeviceId: null,
				payload: {
					gates: {
						dispatch: 'manual',
						review: 'auto',
						landing: 'auto',
					},
				},
			});
		});

		// 验证 4: 回流到达后解除 pending 态，DOM 正式翻转为 auto，常驻说明呈现！
		expect(togglesDiv?.getAttribute('data-pending')).toBe('false');
		expect(manualBtn?.getAttribute('data-state')).toBe('inactive');
		expect(autoBtn?.getAttribute('data-state')).toBe('active');
		expect(container.querySelector('[data-testid="landing-auto-note"]')).not.toBeNull();
	});

	// ─── 7. PATCH 异常时解除 pending 保持原值 ───
	it('clears pending on patch failure without altering local gate values (R4)', async () => {
		const { container, root } = setupMockDom();

		const patcher = vi.fn(async () => {
			throw new Error('Network error');
		});

		await act(async () => {
			root.render(
				createElement(GateTogglesContainer, {
					initialGates: initialValues,
					patcher,
				}),
			);
		});

		const togglesDiv = container.querySelector('[data-component="gate-toggles"]');
		const landingToggleGroup = container.querySelector('[data-gate-toggle="landing"]');
		const autoBtn = landingToggleGroup?.querySelectorAll('button')[1];

		await act(async () => {
			autoBtn?.click();
		});

		// 失败后立即解除 pending，不处于永久置灰死锁
		expect(togglesDiv?.getAttribute('data-pending')).toBe('false');
		const manualBtn = landingToggleGroup?.querySelectorAll('button')[0];
		expect(manualBtn?.getAttribute('data-state')).toBe('active');
	});
});
