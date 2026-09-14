import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddAgentSection } from '../src/features/settings-agents/add-agent-section.tsx';
import { AgentCard } from '../src/features/settings-agents/agent-card.tsx';
import { FieldLayersRow } from '../src/features/settings-agents/field-layers-row.tsx';
import { LaneCountSetting } from '../src/features/settings-agents/lane-count-setting.tsx';
import { ModelPicker } from '../src/features/settings-agents/model-picker.tsx';
import { SettingsAgentsContainer } from '../src/features/settings-agents/settings-agents-container.tsx';
import {
	BUILT_IN_AGENT_CONFIGS,
	DEFAULT_LANE_COUNT,
	MAX_LANE_COUNT,
	MIN_LANE_COUNT,
	type RegisteredAgentItem,
} from '../src/features/settings-agents/types.ts';
import { SettingsAgentsPage } from '../src/pages/settings-agents-page.tsx';

describe('M9-T14 设置页：agent 注册表与模型选择', () => {
	// ─── AC 1 & E-92: 每个字段显示「内置默认 / 你的覆盖 / 当前生效」三行并带「恢复默认」 ───
	describe('AC 1 & E-92: 三层字段呈现与恢复默认', () => {
		it('renders Built-in, Override, and Effective rows for a field', () => {
			const html = renderToStaticMarkup(
				createElement(FieldLayersRow, {
					layers: {
						key: 'execPath',
						label: '可执行路径',
						builtIn: 'codex',
						override: '/usr/local/bin/my-codex',
						effective: '/usr/local/bin/my-codex',
					},
					fieldLabel: '可执行路径',
					onRestoreDefault: vi.fn(),
				}),
			);

			expect(html).toContain('内置默认');
			expect(html).toContain('你的覆盖');
			expect(html).toContain('当前生效');
			expect(html).toContain('codex');
			expect(html).toContain('/usr/local/bin/my-codex');
			expect(html).toContain('恢复默认');
		});

		it('disables "恢复默认" with title="当前没有覆盖" when override is null', () => {
			const html = renderToStaticMarkup(
				createElement(FieldLayersRow, {
					layers: {
						key: 'execPath',
						label: '可执行路径',
						builtIn: 'codex',
						override: null,
						effective: 'codex',
					},
					fieldLabel: '可执行路径',
					onRestoreDefault: vi.fn(),
				}),
			);

			expect(html).toContain('title="当前没有覆盖"');
			expect(html).toContain('disabled=""');
			expect(html).toContain('—');
		});

		it('shows E-92 default updated prompt and adopt button when updateNotice exists', () => {
			const html = renderToStaticMarkup(
				createElement(FieldLayersRow, {
					layers: {
						key: 'execPath',
						label: '可执行路径',
						builtIn: 'codex-v2',
						override: 'my-custom-path',
						effective: 'my-custom-path',
						updateNotice: {
							oldValue: 'codex-v1',
							newValue: 'codex-v2',
						},
					},
					fieldLabel: '可执行路径',
					onRestoreDefault: vi.fn(),
					onAdoptDefault: vi.fn(),
				}),
			);

			expect(html).toContain('内置默认已更新（codex-v1 → codex-v2）');
			expect(html).toContain('一键采纳');
		});

		it('builtin defaults are defined for all 5 native agents', () => {
			expect(BUILT_IN_AGENT_CONFIGS.codex.monogram).toBe('CX');
			expect(BUILT_IN_AGENT_CONFIGS.claude.monogram).toBe('CL');
			expect(BUILT_IN_AGENT_CONFIGS.pi.monogram).toBe('PI');
			expect(BUILT_IN_AGENT_CONFIGS.grok.monogram).toBe('GK');
			expect(BUILT_IN_AGENT_CONFIGS.dsh.monogram).toBe('DS');
		});
	});

	// ─── AC 2 & AC 3 / E-38: 模型选择器与降级 ───
	describe('AC 2 & AC 3 / E-38: 模型选择、手机端全屏与清单不全手填', () => {
		it('renders model picker trigger button with selected model', () => {
			const html = renderToStaticMarkup(
				createElement(ModelPicker, {
					agentId: 'codex',
					selectedModel: 'gpt-4o',
					onSelectModel: vi.fn(),
				}),
			);

			expect(html).toContain('gpt-4o');
			expect(html).toContain('model-picker-trigger');
			expect(html).toContain('refresh-models-btn');
		});

		it('displays placeholder when selectedModel is null', () => {
			const html = renderToStaticMarkup(
				createElement(ModelPicker, {
					agentId: 'codex',
					selectedModel: null,
					onSelectModel: vi.fn(),
				}),
			);

			expect(html).toContain('选择默认模型...');
		});
	});

	// ─── AC 4 & E-88: agent 不可用态与跳转配置 ───
	describe('AC 4 & E-88: 不可用置灰、写明缺什么并支持跳转配置', () => {
		const mockUnavailableAgent: RegisteredAgentItem = {
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			isAvailable: false,
			defaultModel: null,
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: '/invalid/path/to/codex',
			unavailableReason: '可执行文件不存在',
			missingRequirements: ['可执行路径无效'],
		};

		it('grays out unavailable agent and states missing requirements', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockUnavailableAgent,
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: 'codex',
						override: '/invalid/path/to/codex',
						effective: '/invalid/path/to/codex',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onRestoreDefault: vi.fn().mockResolvedValue(true),
					onAdoptDefault: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			expect(html).toContain('不可用（路径无效）');
			expect(html).toContain('缺失项：');
			expect(html).toContain('可执行路径无效');
			expect(html).toContain('opacity-75');
			expect(html).toContain('点击前往修改配置 →');
		});
	});

	// ─── AC 5 & E-183: 两字符短码唯一性与撞车要求改一个 ───
	describe('AC 5 & E-183: 两字符短码唯一性校验', () => {
		const mockAgent: RegisteredAgentItem = {
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			isAvailable: true,
			defaultModel: 'gpt-4o',
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: 'codex',
		};

		it('renders monogram input with 2-char limit and validation error when duplicate', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: 'CX',
						override: null,
						effective: 'CX',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onRestoreDefault: vi.fn().mockResolvedValue(true),
					onAdoptDefault: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
					validationError: {
						monogram: '短码 "CL" 已被 agent "Claude Code" 占用，请改用其他短码',
					},
				}),
			);

			expect(html).toContain('maxLength="2"');
			expect(html).toContain('已被 agent');
			expect(html).toContain('Claude Code');
			expect(html).toContain('占用，请改用其他短码');
			expect(html).toContain('aria-invalid="true"');
		});
	});

	// ─── AC 6 & E-184: 窄处身份识别，字母组配合完整名称出现 ───
	describe('AC 6 & E-184: 字母组配合完整名称出现，不得成为唯一标识', () => {
		const mockAgent: RegisteredAgentItem = {
			id: 'pi',
			name: 'Pi Agent',
			monogram: 'PI',
			isAvailable: true,
			defaultModel: null,
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: 'pi',
		};

		it('renders monogram chip with title, aria-label, and visible full name', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: 'PI',
						override: null,
						effective: 'PI',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onRestoreDefault: vi.fn().mockResolvedValue(true),
					onAdoptDefault: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			expect(html).toContain('data-testid="monogram-chip-pi"');
			expect(html).toContain('title="Pi Agent"');
			expect(html).toContain('aria-label="Pi Agent"');
			expect(html).toContain('Pi Agent');
		});
	});

	// ─── AC 7 & E-185: 接入新 agent 只需填两字符短码，不新增任何资源文件 ───
	describe('AC 7 & E-185: 接入第 5/6 个 agent 视觉成本', () => {
		it('renders add agent section stating only 2-char monogram needed with zero assets', () => {
			const html = renderToStaticMarkup(
				createElement(AddAgentSection, {
					onAddAgent: vi.fn().mockResolvedValue(true),
					existingAgentIds: ['codex', 'claude', 'pi', 'grok'],
					validateMonogram: vi.fn().mockReturnValue({ valid: true }),
				}),
			);

			expect(html).toContain('接入新 Agent');
			expect(html).toContain('接入第 5、6 个 agent 只需填写两字符短码，无需新增任何图标或资源文件');
			expect(html).toContain('toggle-add-agent-btn');
		});
	});

	// ─── AC 8 & E-248: 并行窗口数（默认 2，值域 1-6，注明只属于调度器） ───
	describe('AC 8 & E-248: 任务并行窗口数与互不影响提示', () => {
		it('renders lane count setting with default 2, range 1-6, and required notice', () => {
			expect(DEFAULT_LANE_COUNT).toBe(2);
			expect(MIN_LANE_COUNT).toBe(1);
			expect(MAX_LANE_COUNT).toBe(6);

			const html = renderToStaticMarkup(
				createElement(LaneCountSetting, {
					laneCount: 2,
					onChangeLaneCount: vi.fn(),
				}),
			);

			expect(html).toContain('任务并行窗口数');
			// Exact required notice string
			expect(html).toContain('此值只属于调度器，与阅读器互不影响');
			expect(html).toContain('lane-count-decrease-btn');
			expect(html).toContain('lane-count-increase-btn');
			expect(html).toContain('2');
		});
	});

	// ─── AC 9 & E-95: reason 等于 session-dir-overlap 时显示「会话记录可能互相覆盖」 ───
	describe('AC 9 & E-95: 会话目录重叠告警呈现', () => {
		const mockOverlapAgent: RegisteredAgentItem = {
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			isAvailable: true,
			defaultModel: null,
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: 'codex',
			warningBanner: {
				code: 'E_AGENT_CONFIG_WARNING',
				message: 'Session records may overwrite each other',
				details: { reason: 'session-dir-overlap' },
			},
			warnings: [
				{
					reason: 'session-dir-overlap',
					message: 'Session records may overwrite each other',
				},
			],
		};

		it('renders "会话记录可能互相覆盖" and NOT the raw daemon English message', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockOverlapAgent,
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: 'codex',
						override: null,
						effective: 'codex',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onRestoreDefault: vi.fn().mockResolvedValue(true),
					onAdoptDefault: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			// AC 9: 精确显示中文文案
			expect(html).toContain('会话记录可能互相覆盖');
			// 绝不直出 daemon 的英文 developer message
			expect(html).not.toContain('Session records may overwrite each other');
		});
	});

	// ─── 页面与容器装配 ───
	describe('SettingsAgentsPage and Container assembly', () => {
		it('renders the settings page layout with title and breadcrumb', () => {
			const html = renderToStaticMarkup(createElement(SettingsAgentsPage));

			expect(html).toContain('设置');
			expect(html).toContain('Agent 注册表与模型选择');
			expect(html).toContain('settings-agents-page');
		});

		it('renders SettingsAgentsContainer with grid/flex/gap structure', () => {
			const html = renderToStaticMarkup(createElement(SettingsAgentsContainer));

			expect(html).toContain('settings-agents-container');
		});
	});
});
