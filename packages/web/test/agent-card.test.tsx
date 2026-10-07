// @vitest-environment jsdom
/**
 * packages/web/test/agent-card.test.tsx
 *
 * M9-T23 设置页 Agent 卡片测试（AC 7, E-254, E-335, E-336, E-355, E-358）
 */

import type { AgentEntryDto, ListAgentModelsResponse } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard } from '../src/components/agent-card.tsx';
import type { FieldLayerValues } from '../src/components/field-layers-row.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockFieldLayers: FieldLayerValues = {
	key: 'monogram',
	label: '两字符短码',
	builtIn: '—',
	override: null,
	effective: 'CX',
};

const mockBaseAgent: AgentEntryDto = {
	id: 'codex',
	name: 'Codex',
	monogram: 'CX',
	isAvailable: true,
	defaultModel: 'gpt-4o',
	defaultEffortTier: { tier: 'medium' },
	maxConcurrency: 2,
	permissionTier: 'workspaceWrite',
	execPath: '/usr/local/bin/codex',
	effortVendorMap: {
		low: 'low',
		medium: 'medium',
		high: 'high',
	},
	login: {
		state: 'logged_in',
		reason: null,
		checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
		loginCommand: 'codex login',
		warningCode: null,
	},
	layers: {
		defaultModel: {
			builtin: 'gpt-4o-mini',
			config: 'gpt-4o',
			override: 'custom-model-x',
			hasOverride: true,
		},
		defaultEffortTier: {
			builtin: { tier: 'low' },
			config: { tier: 'medium' },
			override: { tier: 'high' },
			hasOverride: true,
		},
	},
};

const mockCatalog: ListAgentModelsResponse = {
	models: [
		{ name: 'gpt-4o', source: 'live', isCurrentConfig: true },
		{ name: 'gpt-4o-mini', source: 'builtin', isCurrentConfig: false },
	],
	isComplete: true,
	refreshedAt: new Date().toISOString(),
	liveFailure: null,
	currentConfig: {
		model: 'gpt-4o',
		effort: { tier: 'medium' },
		configPath: '/path/config',
		effortRecognized: true,
	},
	isRefreshing: false,
};

it.each([{ effortOptions: [] }, { effortOptions: ['max'] }])(
	'uses the configured model capability $effortOptions when defaultModel is explicitly null',
	async ({ effortOptions }) => {
		const host = document.createElement('div');
		document.body.append(host);
		const root = createRoot(host);
		const onUpdateEffortTier = vi.fn();
		try {
			await act(async () =>
				root.render(
					createElement(AgentCard, {
						agent: {
							...mockBaseAgent,
							defaultModel: null,
							defaultEffortTier: { vendor: 'ultra' },
							effortOptions: ['max', 'ultra'],
							layers: {
								...mockBaseAgent.layers,
								defaultModel: {
									builtin: 'gpt-4o-mini',
									config: 'gpt-4o',
									override: null,
									hasOverride: true,
								},
								defaultEffortTier: mockBaseAgent.layers?.defaultEffortTier ?? {
									builtin: null,
									config: null,
									override: null,
									hasOverride: false,
								},
							},
						},
						catalog: {
							...mockCatalog,
							models: [{ name: 'gpt-4o', source: 'live', isCurrentConfig: true, effortOptions }],
						},
						getFieldLayers: () => mockFieldLayers,
						models: mockCatalog.models,
						onUpdateField: vi.fn(),
						onUpdateEffortTier,
						onProbe: vi.fn(),
					}),
				),
			);
			if (effortOptions.length === 0)
				expect(host.querySelector('[data-testid="effort-unsupported-display"]')).not.toBeNull();
			else
				expect(host.querySelector('[data-testid="effort-support-warning"]')?.textContent).toContain(
					'ultra',
				);
			expect(onUpdateEffortTier).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	},
);

it('keeps the rendered layer labels, actions and accessible names unchanged (E-358)', async () => {
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	const onClearOverride = vi.fn().mockResolvedValue(false);
	try {
		await act(async () =>
			root.render(
				createElement(AgentCard, {
					agent: mockBaseAgent,
					catalog: mockCatalog,
					getFieldLayers: () => mockFieldLayers,
					onUpdateField: vi.fn(),
					onProbe: vi.fn(),
					onClearOverride,
					models: mockCatalog.models,
				}),
			),
		);
		for (const text of ['内置默认', '你的覆盖', '当前生效', '默认模型', '思考强度', '清单未列']) {
			expect(host.textContent).toContain(text);
		}
		expect(
			host.querySelector('[data-testid="input-monogram-codex"]')?.getAttribute('aria-label'),
		).toBe('两字符短码');
		expect(
			host.querySelector('[data-testid="input-monogram-codex"]')?.getAttribute('placeholder'),
		).toBe('2字符短码');
		expect(
			host.querySelector('[data-testid="input-execPath-codex"]')?.getAttribute('aria-label'),
		).toBe('可执行路径');
		const restore = host.querySelector<HTMLButtonElement>(
			'[data-testid="restore-default-defaultModel-codex"]',
		);
		expect(restore?.textContent).toBe('恢复默认');
		await act(async () => restore?.click());
		expect(onClearOverride).toHaveBeenCalledWith('codex', 'defaultModel');
		expect(host.querySelector('[data-testid="layer-override-defaultModel"]')?.textContent).toBe(
			'custom-model-x',
		);
		await act(async () =>
			root.render(
				createElement(AgentCard, {
					agent: mockBaseAgent,
					getFieldLayers: () => mockFieldLayers,
					onUpdateField: vi.fn(),
					onProbe: vi.fn(),
					models: [],
					isModelsRefreshing: true,
					isProbing: true,
				}),
			),
		);
		expect(host.querySelector('[data-testid="refresh-models-btn-codex"]')?.textContent).toBe(
			'刷新中...',
		);
		expect(host.querySelector('[data-testid="probe-agent-btn-codex"]')?.textContent).toBe(
			'探测中...',
		);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

describe('M9-T23: AgentCard 设置页组件', () => {
	it('marks an override unlisted in an authoritative empty catalog (E-358)', () => {
		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: mockBaseAgent,
				catalog: { ...mockCatalog, models: [] },
				getFieldLayers: () => mockFieldLayers,
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: [],
			}),
		);
		expect(html).toContain('data-testid="unlisted-model-chip-codex"');
	});
	it('renders login badge and action buttons (refresh models & reprobe) in card header', () => {
		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: mockBaseAgent,
				getFieldLayers: () => mockFieldLayers,
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: ['gpt-4o'],
				onRefreshModels: vi.fn(),
			}),
		);

		// 头部徽标
		expect(html).toContain('data-testid="login-badge"');
		expect(html).toContain('已登录');
		// 刷新清单按钮
		expect(html).toContain('data-testid="refresh-models-btn-codex"');
		expect(html).toContain('刷新清单');
		// 重新探测按钮
		expect(html).toContain('data-testid="probe-agent-btn-codex"');
		expect(html).toContain('重新探测');
	});

	it('renders login hint when agent is logged_out', () => {
		const loggedOutAgent: AgentEntryDto = {
			...mockBaseAgent,
			login: {
				state: 'logged_out',
				reason: null,
				checkedAt: new Date().toISOString(),
				loginCommand: 'codex login',
				warningCode: null,
			},
		};

		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: loggedOutAgent,
				getFieldLayers: () => mockFieldLayers,
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: ['gpt-4o'],
			}),
		);

		expect(html).toContain('data-testid="login-hint"');
		expect(html).toContain('未登录：在终端运行');
		expect(html).toContain('codex login');
		expect(html).toContain('后点刷新');
		expect(html).toContain('复制命令');
	});

	it('renders defaultModel 3-row layer values and unlisted chip when override is not in catalog', () => {
		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: mockBaseAgent,
				catalog: mockCatalog,
				getFieldLayers: () => mockFieldLayers,
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: ['gpt-4o'],
			}),
		);

		// 内置默认读 layers.defaultModel.builtin
		expect(html).toContain('data-testid="layer-builtin-defaultModel"');
		expect(html).toContain('gpt-4o-mini');
		// 你的覆盖读 layers.defaultModel.override
		expect(html).toContain('data-testid="layer-override-defaultModel"');
		expect(html).toContain('custom-model-x');
		// custom-model-x 不在 catalog 中，显示「清单未列」chip
		expect(html).toContain('data-testid="unlisted-model-chip-codex"');
		expect(html).toContain('清单未列');
		// 当前生效读顶层 defaultModel
		expect(html).toContain('data-testid="layer-effective-defaultModel"');
		expect(html).toContain('gpt-4o');

		// 恢复默认按钮在有覆盖时处于启用状态
		expect(html).toContain('data-testid="restore-default-defaultModel-codex"');
	});

	it('renders defaultEffortTier 3-row layer values and restore default button', () => {
		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: mockBaseAgent,
				catalog: mockCatalog,
				getFieldLayers: () => mockFieldLayers,
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: ['gpt-4o'],
			}),
		);

		// 内置默认读 layers.defaultEffortTier.builtin (low -> 低)
		expect(html).toContain('data-testid="layer-builtin-defaultEffortTier"');
		expect(html).toContain('低');
		// 你的覆盖读 layers.defaultEffortTier.override (high -> 高)
		expect(html).toContain('data-testid="layer-override-defaultEffortTier"');
		expect(html).toContain('高');
		// 当前生效读顶层 defaultEffortTier (medium -> 中)
		expect(html).toContain('data-testid="layer-effective-defaultEffortTier"');
		expect(html).toContain('中');

		expect(html).toContain('data-testid="restore-default-defaultEffortTier-codex"');
	});

	it('disables restore default button when hasOverride is false and sets title to "当前没有覆盖"', () => {
		const noOverrideAgent: AgentEntryDto = {
			...mockBaseAgent,
			layers: {
				defaultModel: {
					builtin: 'gpt-4o',
					config: 'gpt-4o',
					override: null,
					hasOverride: false,
				},
				defaultEffortTier: {
					builtin: { tier: 'medium' },
					config: { tier: 'medium' },
					override: null,
					hasOverride: false,
				},
			},
		};

		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: noOverrideAgent,
				catalog: mockCatalog,
				getFieldLayers: () => mockFieldLayers,
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: ['gpt-4o'],
			}),
		);

		// 检查无覆盖置灰不隐藏且 title 为「当前没有覆盖」
		expect(html).toContain('data-testid="restore-default-defaultModel-codex"');
		expect(html).toContain('data-testid="restore-default-defaultEffortTier-codex"');
		expect(html).toContain('title="当前没有覆盖"');
		// 你的覆盖显示「—」
		expect(html).toContain('data-testid="layer-override-defaultModel"');
		expect(html).toContain('data-testid="layer-override-defaultEffortTier"');
	});

	it('renders "该 agent 不支持" and DOES NOT render 3 rows or restore button when effortVendorMap is null (E-358)', () => {
		const unsupportedEffortAgent: AgentEntryDto = {
			...mockBaseAgent,
			id: 'dsh',
			name: 'Dsh',
			effortVendorMap: null, // 不支持思考强度
		};

		const html = renderToStaticMarkup(
			createElement(AgentCard, {
				agent: unsupportedEffortAgent,
				getFieldLayers: () => ({
					...mockFieldLayers,
					effective: 'DH',
				}),
				onUpdateField: vi.fn(),
				onProbe: vi.fn(),
				models: ['dsh-model'],
			}),
		);

		// 渲染该 agent 不支持
		expect(html).toContain('data-testid="effort-unsupported-block-dsh"');
		expect(html).toContain('该 agent 不支持');
		// 绝不渲染三行与恢复默认按钮
		expect(html).not.toContain('data-testid="layer-builtin-defaultEffortTier"');
		expect(html).not.toContain('data-testid="restore-default-defaultEffortTier-dsh"');
	});
});
