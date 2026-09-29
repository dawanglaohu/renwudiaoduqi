/**
 * packages/web/test/pipeline-assignment.test.tsx
 *
 * 流水线审查覆盖与收口指派设置展示组件单元测试（M9-T23 / AC 8, E-356）
 */

import type { AgentEntryDto } from '@agent-scheduler/shared/api/agents';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PipelineAssignment } from '../src/components/pipeline-assignment.tsx';
import { UI_STRINGS } from '../src/i18n/ui-strings.ts';

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
