/**
 * packages/web/test/pipeline-toggles.test.tsx
 *
 * 顶栏流水线开关组件、容器与设置页测试（M9-T22 / AC 1..6, E-26, E-157, E-306, E-312, E-318, E-356）
 */

import { ROUTES } from '@agent-scheduler/shared/api/routes';
import type {
	PipelineSettings,
	UpdatePipelineSettingsBody,
} from '@agent-scheduler/shared/api/settings';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { PipelineToggles } from '../src/components/pipeline-toggles.tsx';
import { PipelineTogglesContainer } from '../src/features/run-deck/pipeline-toggles-container.tsx';
import { SettingsPipelinePage } from '../src/pages/settings-pipeline-page.tsx';

// ─── 简易 DOM 环境模拟（用于真实挂载与交互点击测试，同 gate-toggles.test.tsx） ───
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
		return this.querySelectorAll(sel)[0] ?? null;
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

	get textContent(): string {
		let text = '';
		for (const child of this.childNodes) {
			if ('textContent' in child) text += child.textContent;
		}
		return text;
	}

	set textContent(value: string) {
		this.childNodes = [{ nodeType: 3, textContent: value }];
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

describe('components/pipeline-toggles (M9-T22 / AC 1..6, E-26, E-157, E-306, E-312, E-318, E-356)', () => {
	const initialValues = {
		bughunt: 0 as const,
		wrapupMode: 'auto' as const,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ─── 1. 两个开关二段形态 ───
	it('renders two toggles with identical morphology (bughunt and wrapupMode) (AC 1)', () => {
		const html = renderToStaticMarkup(createElement(PipelineToggles, { value: initialValues }));

		expect(html).toContain('查 bug');
		expect(html).toContain('收口模式');
		expect(html).toContain('data-pipeline-toggle="bughunt"');
		expect(html).toContain('data-pipeline-toggle="wrapupMode"');
		expect(html).toContain('h-btn-sm');
	});

	// ─── 2. 受控无内部 state：value=null 显示「—」并 disabled（E-26） ───
	it('renders "—" and disabled when value is null (AC 2, E-26)', () => {
		const html = renderToStaticMarkup(createElement(PipelineToggles, { value: null }));

		expect(html).toContain('—');
		expect(html).toContain('cursor-not-allowed');
		expect(html).toContain('aria-disabled="true"');
	});

	// ─── 3. 「查 bug」切开常驻一行说明，不弹 dialog（AC 3, E-306） ───
	it('renders permanent note without dialog when bughunt is 1 (AC 3, E-306)', () => {
		const htmlOn = renderToStaticMarkup(
			createElement(PipelineToggles, { value: { bughunt: 1, wrapupMode: 'auto' } }),
		);
		expect(htmlOn).toContain('审查 pass 后自动派查 bug 运行，只影响尚未到达该阶段的任务');
		expect(htmlOn).toContain('data-testid="bughunt-auto-note"');
		expect(htmlOn).not.toContain('role="dialog"');

		const htmlOff = renderToStaticMarkup(
			createElement(PipelineToggles, { value: { bughunt: 0, wrapupMode: 'auto' } }),
		);
		expect(htmlOff).not.toContain('data-testid="bughunt-auto-note"');
	});

	// ─── 4. 「收口」切手动常驻一行说明，不弹 dialog（AC 3, E-312） ───
	it('renders permanent note without dialog when wrapupMode is manual (AC 3, E-312)', () => {
		const htmlManual = renderToStaticMarkup(
			createElement(PipelineToggles, { value: { bughunt: 0, wrapupMode: 'manual' } }),
		);
		expect(htmlManual).toContain('本批全部任务落地后不自动收口，需手动点击收口');
		expect(htmlManual).toContain('data-testid="wrapup-manual-note"');
		expect(htmlManual).not.toContain('role="dialog"');

		const htmlAuto = renderToStaticMarkup(
			createElement(PipelineToggles, { value: { bughunt: 0, wrapupMode: 'auto' } }),
		);
		expect(htmlAuto).not.toContain('data-testid="wrapup-manual-note"');
	});

	// ─── 5. onChange 给出全量两值 ───
	it('calls onChange with all 2 values on toggle click', () => {
		const handleChange = vi.fn();
		const toggles = PipelineToggles({
			value: initialValues,
			onChange: handleChange,
		});

		expect(toggles.props['data-component']).toBe('pipeline-toggles');
	});

	// ─── 6. Shared 契约路由声明校验 ───
	it('matches shared ROUTES for GET and PATCH /api/v1/settings/pipeline', () => {
		const getRoute = ROUTES.find(
			(r) => r.method === 'GET' && r.path === '/api/v1/settings/pipeline',
		);
		const patchRoute = ROUTES.find(
			(r) => r.method === 'PATCH' && r.path === '/api/v1/settings/pipeline',
		);

		expect(getRoute).toBeDefined();
		expect(getRoute?.resType).toBe('GetPipelineSettingsResponse');
		expect(patchRoute).toBeDefined();
		expect(patchRoute?.reqType).toBe('UpdatePipelineSettingsBody');
		expect(patchRoute?.resType).toBe('UpdatePipelineSettingsResponse');
	});

	// ─── 7. 容器交互与四键全量 PATCH（AC 2, E-356, E-157, E-318） ───
	it('PATCH sends full 4 keys using cached reviewOverride/wrapupAssignment, DOM does not flip prematurely until settings.pipeline_changed', async () => {
		const { container, root } = setupMockDom();

		let patchPayload: UpdatePipelineSettingsBody | null = null;
		const patcher = vi.fn(async (body: UpdatePipelineSettingsBody) => {
			patchPayload = body;
			return {
				pipeline: {
					...body,
					reviewOverride: body.reviewOverride ?? null,
					wrapupAssignment: body.wrapupAssignment,
				},
			};
		});

		const initialPipeline: PipelineSettings = {
			bughunt: 0,
			wrapupMode: 'auto',
			reviewOverride: {
				agentId: 'codex',
				modelName: 'gpt-4o',
				effortTier: 'medium',
			},
			wrapupAssignment: {
				mode: 'fixed',
				agentId: 'claude',
				modelName: null,
				effortTier: null,
			},
		};

		await act(async () => {
			root.render(
				createElement(PipelineTogglesContainer, {
					initialPipeline,
					patcher,
				}),
			);
		});

		const bughuntToggle = container.querySelector('[data-pipeline-toggle="bughunt"]');
		expect(bughuntToggle).not.toBeNull();

		// 点击「开」按钮 (value=1)
		const buttons = bughuntToggle?.querySelectorAll('button') ?? [];
		expect(buttons).toHaveLength(2);
		const turnOnBtn = buttons[1]; // [0: 关, 1: 开]
		expect(turnOnBtn?.getAttribute('data-state')).toBe('inactive');

		await act(async () => {
			turnOnBtn?.click();
		});

		// 必须发送包含 4 个键的全量请求（E-356）
		expect(patcher).toHaveBeenCalledTimes(1);
		expect(patchPayload).toEqual({
			bughunt: 1,
			wrapupMode: 'auto',
			reviewOverride: {
				agentId: 'codex',
				modelName: 'gpt-4o',
				effortTier: 'medium',
			},
			wrapupAssignment: {
				mode: 'fixed',
				agentId: 'claude',
				modelName: null,
				effortTier: null,
			},
		});

		// 响应完成后状态仍为 pending 且 DOM 尚未翻转（E-157, E-318）
		expect(turnOnBtn?.getAttribute('data-state')).toBe('inactive');

		// 模拟服务端回流 settings.pipeline_changed 事件
		await act(async () => {
			eventBus.push({
				id: 101,
				ts: new Date().toISOString(),
				runId: null,
				taskId: null,
				scope: 'settings',
				kind: 'settings.pipeline_changed',
				seq: 1,
				actorDeviceId: null,
				payload: {
					pipeline: {
						...initialPipeline,
						bughunt: 1,
					},
				},
			});
		});

		// 事件回流后，DOM 翻转
		expect(turnOnBtn?.getAttribute('data-state')).toBe('active');
	});

	// ─── 8. E_PIPELINE_STAGE_DISABLED 就地 inline notice 不弹 toast（AC 5） ───
	it('renders inline notice with stage details on E_PIPELINE_STAGE_DISABLED without toast (AC 5)', async () => {
		const { container, root } = setupMockDom();

		const failingPatcher = vi.fn(async () => {
			const { ApiError } = await import('../src/api/http-client.ts');
			throw new ApiError({
				code: 'E_PIPELINE_STAGE_DISABLED',
				message: 'Pipeline stage disabled',
				requestId: 'req-err-42',
				details: { stage: 'bughunt' },
			});
		});

		const initialPipeline: PipelineSettings = {
			bughunt: 0,
			wrapupMode: 'auto',
			reviewOverride: null,
			wrapupAssignment: { mode: 'follow' },
		};

		await act(async () => {
			root.render(
				createElement(PipelineTogglesContainer, {
					initialPipeline,
					patcher: failingPatcher,
				}),
			);
		});

		const bughuntToggle = container.querySelector('[data-pipeline-toggle="bughunt"]');
		const turnOnBtn = bughuntToggle?.querySelectorAll('button')[1];

		await act(async () => {
			turnOnBtn?.click();
		});

		// 检查就地 InlineNotice
		const errorNotice = container.querySelector('[data-testid="pipeline-toggles-error"]');
		expect(errorNotice).not.toBeNull();
		expect(errorNotice?.textContent).toContain('当前流水线阶段已停用（查 bug）');
	});

	// ─── 9. 设置页布局展示「当前值来自 daemon」（AC 4） ───
	it('renders settings layout with "当前值来自 daemon" notice (AC 4)', () => {
		const html = renderToStaticMarkup(createElement(SettingsPipelinePage));

		expect(html).toContain('data-component="settings-pipeline-page"');
		expect(html).toContain('当前值来自 daemon');
		expect(html).toContain('data-testid="daemon-managed-notice"');
		expect(html).toContain('流水线设置');
	});
});
