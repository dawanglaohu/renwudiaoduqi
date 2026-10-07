// @vitest-environment jsdom
/**
 * packages/web/test/pipeline-assignment.test.tsx
 *
 * 流水线审查覆盖与收口指派设置展示组件单元测试（M9-T23 / AC 8, E-356）
 */

import type { AgentEntryDto } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PipelineAssignment } from '../src/components/pipeline-assignment.tsx';
import { UI_STRINGS } from '../src/i18n/ui-strings.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('preserves both executing Agent labels and field error paths in the actual DOM (E-356)', async () => {
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				createElement(PipelineAssignment, {
					reviewOverride: { agentId: 'agent-1', modelName: null, effortTier: null },
					wrapupAssignment: {
						mode: 'fixed',
						agentId: 'agent-2',
						modelName: null,
						effortTier: null,
					},
					onChangeReviewOverride: vi.fn(),
					onChangeWrapupAssignment: vi.fn(),
					agents: mockAgents,
					errors: {
						'reviewOverride.agentId': '请选择存在的 Agent',
						'wrapupAssignment.agentId': '请选择存在的 Agent',
					},
				}),
			),
		);
		for (const id of ['review-override-agent-select', 'wrapup-assignment-agent-select']) {
			expect(host.querySelector(`label[for="${id}"]`)?.textContent).toBe('执行 Agent');
			expect(host.querySelector(`#${id}`)?.getAttribute('aria-invalid')).toBe('true');
		}
		for (const field of ['reviewOverride', 'wrapupAssignment']) {
			expect(host.querySelector(`[data-testid="error-${field}-agentId"]`)?.textContent).toBe(
				'请选择存在的 Agent',
			);
		}
		expect(host.textContent).toContain('跟随任务');
		expect(host.textContent).toContain('自定义指定');
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it('waits for the agent registry before allowing a custom pipeline assignment', async () => {
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	const onReview = vi.fn();
	const onWrapup = vi.fn();
	const render = (agents: readonly AgentEntryDto[]) =>
		createElement(PipelineAssignment, {
			reviewOverride: null,
			wrapupAssignment: { mode: 'follow' },
			onChangeReviewOverride: onReview,
			onChangeWrapupAssignment: onWrapup,
			agents,
		});
	try {
		await act(async () => root.render(render([])));
		const custom = host.querySelector<HTMLButtonElement>(
			'[data-testid="review-override-custom-btn"]',
		);
		expect(custom?.disabled).toBe(true);
		await act(async () => custom?.click());
		expect(onReview).not.toHaveBeenCalled();
		await act(async () => root.render(render(mockAgents)));
		await act(async () => custom?.click());
		expect(onReview).toHaveBeenCalledWith({
			agentId: mockAgents[0]?.id,
			modelName: null,
			effortTier: null,
		});
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it('displays native effort selections and clears them when switching review agents', async () => {
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	const onReview = vi.fn();
	try {
		await act(async () =>
			root.render(
				createElement(PipelineAssignment, {
					reviewOverride: { agentId: 'agent-1', effortVendor: 'max' },
					wrapupAssignment: { mode: 'fixed', agentId: 'agent-2', effortVendor: 'ultra' },
					onChangeReviewOverride: onReview,
					onChangeWrapupAssignment: vi.fn(),
					agents: mockAgents,
					errors: { 'reviewOverride.effortVendor': '该模型不支持 max' },
				}),
			),
		);
		expect(
			host.querySelector('[data-testid="review-override-section"] [data-testid="effort-picker"]')
				?.textContent,
		).toContain('max');
		expect(
			host.querySelector('[data-testid="wrapup-assignment-section"] [data-testid="effort-picker"]')
				?.textContent,
		).toContain('ultra');
		expect(host.textContent).toContain('该模型不支持 max');
		const select = host.querySelector<HTMLSelectElement>('#review-override-agent-select');
		await act(async () => {
			if (!select) throw new Error('missing review agent selector');
			select.value = 'agent-2';
			select.dispatchEvent(new Event('change', { bubbles: true }));
		});
		expect(onReview).toHaveBeenCalledWith({
			agentId: 'agent-2',
			modelName: null,
			effortTier: null,
			effortVendor: null,
		});
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

const mockAgents: AgentEntryDto[] = [
	{
		id: 'agent-1',
		name: 'Claude Agent',
		monogram: 'CL',
		isAvailable: true,
		maxConcurrency: 2,
		permissionTier: 'workspaceWrite',
		execPath: '/path/claude',
		defaultModel: 'claude-3-5-sonnet',
		defaultEffortTier: { tier: 'high' },
		effortVendorMap: {
			low: 'low',
			medium: 'medium',
			high: 'high',
		},
		builtinModels: [{ name: 'claude-3-5-sonnet' }, { name: 'claude-3-haiku' }],
		layers: {
			defaultModel: {
				builtin: 'claude-3-5-sonnet',
				config: null,
				override: null,
				hasOverride: false,
			},
			defaultEffortTier: {
				builtin: { tier: 'high' },
				config: null,
				override: null,
				hasOverride: false,
			},
		},
		login: {
			state: 'logged_in',
			reason: null,
			checkedAt: new Date().toISOString(),
			loginCommand: null,
			warningCode: null,
		},
	},
	{
		id: 'agent-2',
		name: 'Codex Agent',
		monogram: 'CX',
		isAvailable: true,
		maxConcurrency: 2,
		permissionTier: 'workspaceWrite',
		execPath: '/path/codex',
		defaultModel: 'o3-mini',
		defaultEffortTier: { tier: 'medium' },
		effortVendorMap: {
			low: 'low',
			medium: 'medium',
			high: 'high',
		},
		builtinModels: [{ name: 'o3-mini' }],
		layers: {
			defaultModel: {
				builtin: 'o3-mini',
				config: null,
				override: null,
				hasOverride: false,
			},
			defaultEffortTier: {
				builtin: { tier: 'medium' },
				config: null,
				override: null,
				hasOverride: false,
			},
		},
		login: {
			state: 'logged_in',
			reason: null,
			checkedAt: new Date().toISOString(),
			loginCommand: null,
			warningCode: null,
		},
	},
];

describe('PipelineAssignment Component (AC 8, E-356)', () => {
	it('renders follow notes by default without opening any modal/dialog (AC 8)', () => {
		const html = renderToStaticMarkup(
			createElement(PipelineAssignment, {
				reviewOverride: null,
				wrapupAssignment: { mode: 'follow' },
				onChangeReviewOverride: vi.fn(),
				onChangeWrapupAssignment: vi.fn(),
				agents: mockAgents,
			}),
		);

		expect(html).toContain(UI_STRINGS.pipelineAssignment.reviewOverrideFollowNote);
		expect(html).toContain(UI_STRINGS.pipelineAssignment.wrapupAssignmentFollowNote);

		// 没有自定义表单输入框
		expect(html).not.toContain('data-testid="review-override-agent-select"');
		expect(html).not.toContain('data-testid="wrapup-assignment-agent-select"');
	});

	it('renders custom fields when in custom mode', () => {
		const html = renderToStaticMarkup(
			createElement(PipelineAssignment, {
				reviewOverride: {
					agentId: 'agent-1',
					modelName: 'claude-3-5-sonnet',
					effortTier: 'high',
				},
				wrapupAssignment: {
					mode: 'fixed',
					agentId: 'agent-2',
					modelName: 'o3-mini',
					effortTier: 'medium',
				},
				onChangeReviewOverride: vi.fn(),
				onChangeWrapupAssignment: vi.fn(),
				agents: mockAgents,
			}),
		);

		// 检查 review 与 wrapup agent 选择器存在
		expect(html).toContain('data-testid="review-override-agent-select"');
		expect(html).toContain('data-testid="wrapup-assignment-agent-select"');
		expect(html).toContain('Claude Agent');
		expect(html).toContain('Codex Agent');
	});

	it('renders validation error messages in place with aria-invalid (AC 8, E-356)', () => {
		const html = renderToStaticMarkup(
			createElement(PipelineAssignment, {
				reviewOverride: {
					agentId: '',
					modelName: null,
					effortTier: null,
				},
				wrapupAssignment: {
					mode: 'fixed',
					agentId: 'non-existent',
					modelName: null,
					effortTier: null,
				},
				onChangeReviewOverride: vi.fn(),
				onChangeWrapupAssignment: vi.fn(),
				agents: mockAgents,
				errors: {
					'reviewOverride.agentId': '必须指定有效的审查 agent',
					'wrapupAssignment.agentId': '指定的收口 agent 不存在于注册表',
				},
			}),
		);

		expect(html).toContain('data-testid="error-reviewOverride-agentId"');
		expect(html).toContain('必须指定有效的审查 agent');
		expect(html).toContain('data-testid="error-wrapupAssignment-agentId"');
		expect(html).toContain('指定的收口 agent 不存在于注册表');
		expect(html).toContain('aria-invalid="true"');
	});

	it('disables all buttons and controls when disabled is true (AC 8)', () => {
		const html = renderToStaticMarkup(
			createElement(PipelineAssignment, {
				reviewOverride: {
					agentId: 'agent-1',
					modelName: null,
					effortTier: null,
				},
				wrapupAssignment: {
					mode: 'fixed',
					agentId: 'agent-2',
					modelName: null,
					effortTier: null,
				},
				onChangeReviewOverride: vi.fn(),
				onChangeWrapupAssignment: vi.fn(),
				agents: mockAgents,
				disabled: true,
			}),
		);

		expect(html).toContain('data-testid="review-override-follow-btn"');
		expect(html).toContain('data-testid="review-override-custom-btn"');
		expect(html).toContain('data-testid="wrapup-assignment-follow-btn"');
		expect(html).toContain('data-testid="wrapup-assignment-custom-btn"');
		expect(html).toContain('disabled=""');
	});
});
