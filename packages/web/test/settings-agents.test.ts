import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
	AgentCard,
	type AgentEntryWithLayers,
	UNAVAILABLE_CODE_TITLES,
} from '../src/components/agent-card.tsx';
import { FieldLayersRow } from '../src/components/field-layers-row.tsx';
import {
	DEFAULT_LANE_COUNT,
	LaneCountSetting,
	MAX_LANE_COUNT,
	MIN_LANE_COUNT,
} from '../src/components/lane-count-setting.tsx';
import { ModelPicker } from '../src/components/model-picker.tsx';
import { SettingsAgentsContainer } from '../src/features/settings-agents/settings-agents-container.tsx';
import { SettingsAgentsPage } from '../src/pages/settings-agents-page.tsx';

describe('M9-T14 设置页：agent 注册表与模型选择（返工第 1 轮）', () => {
	// ─── R1 & AC 1: 三层值只读 daemon layers，缺失显示「—」 ───
	describe('R1 & AC 1: 三层字段呈现只读 daemon 字段，未提供显示「—」', () => {
		it('renders Built-in, Override, and Effective rows based on daemon layer values', () => {
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
				}),
			);

			expect(html).toContain('内置默认');
			expect(html).toContain('你的覆盖');
			expect(html).toContain('当前生效');
			expect(html).toContain('codex');
			expect(html).toContain('/usr/local/bin/my-codex');
		});

		it('displays "—" for built-in and override when daemon does not provide layers', () => {
			const html = renderToStaticMarkup(
				createElement(FieldLayersRow, {
					layers: {
						key: 'execPath',
						label: '可执行路径',
						builtIn: '—',
						override: null,
						effective: 'codex',
					},
					fieldLabel: '可执行路径',
				}),
			);

			expect(html).toContain('内置默认');
			expect(html).toContain('你的覆盖');
			expect(html).toContain('当前生效');
			expect(html).toContain('—');
			expect(html).toContain('codex');
		});

		it('does not render write/restore buttons in FieldLayersRow before clearOverrides lands (R1)', () => {
			const html = renderToStaticMarkup(
				createElement(FieldLayersRow, {
					layers: {
						key: 'defaultModel',
						label: '默认模型',
						builtIn: '—',
						override: null,
						effective: 'gpt-4o',
					},
					fieldLabel: '默认模型',
				}),
			);

			// 不把前端假造的默认值发给 daemon，不渲染恢复默认写入口
			expect(html).not.toContain('恢复默认');
		});
	});

	// ─── R2 & E-92: 内置默认更新只呈现 daemon 提供的差异 ───
	describe('R2 & E-92: 内置默认升级差异呈现', () => {
		it('shows default updated notice when updateNotice is supplied by daemon', () => {
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
				}),
			);

			expect(html).toContain('内置默认已更新（codex-v1 → codex-v2）');
		});
	});

	// ─── AC 2 & AC 3 / E-38: 模型选择器、手机全屏与清单不全手填 ───
	describe('AC 2 & AC 3 / E-38: 模型选择、手机端全屏与清单不全手填', () => {
		it('renders model picker trigger button with selected model and models prop', () => {
			const html = renderToStaticMarkup(
				createElement(ModelPicker, {
					models: ['gpt-4o', 'claude-3-5-sonnet'],
					selectedModel: 'gpt-4o',
					onSelectModel: vi.fn(),
				}),
			);

			expect(html).toContain('gpt-4o');
			expect(html).toContain('model-picker-trigger');
		});

		it('displays placeholder when selectedModel is null', () => {
			const html = renderToStaticMarkup(
				createElement(ModelPicker, {
					models: ['gpt-4o'],
					selectedModel: null,
					onSelectModel: vi.fn(),
				}),
			);

			expect(html).toContain('选择默认模型...');
		});

		it('shows "清单可能不全" and renders manual entry input using h-input token (R8)', () => {
			const html = renderToStaticMarkup(
				createElement(ModelPicker, {
					models: ['gpt-4o'],
					selectedModel: 'gpt-4o',
					onSelectModel: vi.fn(),
					isComplete: false,
					initialOpen: true,
				}),
			);

			// AC 3: 清单不全提示
			expect(html).toContain('清单可能不全');
			expect(html).toContain('支持手动输入模型');
			expect(html).toContain('data-testid="manual-model-input"');
			// R8: 检查使用 h-input token 代替 h-input-sm
			expect(html).not.toContain('h-input-sm');
			expect(html).toContain('h-input');
		});
	});

	// ─── R8 & AC 4 / E-88: unavailableCode 映射中文标题，英文进入技术详情 ───
	describe('R8 & AC 4 / E-88: 动态映射不可用文案，英文进技术详情', () => {
		it('maps unavailableCode E_AGENT_EXEC_NOT_FOUND to Chinese title, not hardcoded "路径无效"', () => {
			const mockAgent: AgentEntryWithLayers = {
				id: 'codex',
				name: 'Codex',
				monogram: 'CX',
				isAvailable: false,
				defaultModel: null,
				maxConcurrency: 1,
				permissionTier: 'workspaceWrite',
				execPath: '/invalid/path/to/codex',
				unavailableCode: 'E_AGENT_EXEC_NOT_FOUND',
				unavailableReason: 'executable not found in platform paths',
				missingRequirements: ['Native path for platform'],
			};

			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: '—',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			// R8: 中文标题映射为「未找到可执行文件」
			expect(html).toContain('不可用（未找到可执行文件）');
			expect(html).not.toContain('不可用（路径无效）');
			// R8: 英文 requirement/reason 进入可展开技术详情
			expect(html).toContain('技术详情');
			expect(html).toContain('Native path for platform');
			expect(html).toContain('修改配置 →');
		});

		it('maps unavailableCode E_AGENT_VERSION_UNRECOGNIZED to version title', () => {
			expect(UNAVAILABLE_CODE_TITLES.E_AGENT_VERSION_UNRECOGNIZED).toBe('版本未识别');

			const mockAgent: AgentEntryWithLayers = {
				id: 'pi',
				name: 'Pi Agent',
				monogram: 'PI',
				isAvailable: false,
				defaultModel: null,
				maxConcurrency: 1,
				permissionTier: 'workspaceWrite',
				execPath: 'pi',
				unavailableCode: 'E_AGENT_VERSION_UNRECOGNIZED',
				unavailableReason: 'unrecognized CLI version output',
			};

			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: '—',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			expect(html).toContain('不可用（版本未识别）');
		});
	});

	// ─── R3 & AC 9 / E-95: reason === 'session-dir-overlap' ───
	describe('R3 & AC 9 / E-95: 只按 reason 分支，绝不按英文 message 匹配或直出', () => {
		it('renders "会话记录可能互相覆盖" when errorDetails.reason === "session-dir-overlap"', () => {
			const mockAgent: AgentEntryWithLayers = {
				id: 'codex',
				name: 'Codex',
				monogram: 'CX',
				isAvailable: true,
				defaultModel: null,
				maxConcurrency: 1,
				permissionTier: 'workspaceWrite',
				execPath: 'codex',
				errorDetails: {
					code: 'E_AGENT_CONFIG_WARNING',
					reason: 'session-dir-overlap',
				},
			};

			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: 'CX',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			// AC 9: 精确显示中文文案
			expect(html).toContain('会话记录可能互相覆盖');
			// 绝不直出英文
			expect(html).not.toContain('Session records may overwrite each other');
		});

		it('does NOT trigger warning solely from an English message string (R3)', () => {
			const mockAgentWithoutReason: AgentEntryWithLayers = {
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
				},
			};

			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgentWithoutReason,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: 'CX',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			// R3: 来源未带 reason === 'session-dir-overlap' 时不按英文 message 猜测
			expect(html).not.toContain('会话记录可能互相覆盖');
		});
	});

	// ─── R4 & AC 5 / E-183: 中文错误提示与技术详情 ───
	describe('R4 & AC 5 / E-183: 中文错误展示与英文进入技术详情', () => {
		const mockAgent: AgentEntryWithLayers = {
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			isAvailable: true,
			defaultModel: null,
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: 'codex',
		};

		it('renders Chinese validation error below monogram input and puts technical detail in <details>', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: 'CX',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
					validationError: {
						monogram: {
							message: '短码已被其他 Agent 占用，请改用其他短码',
							technical: 'Monogram "CL" is already in use by agent "claude".',
							requestId: 'req-12345',
						},
					},
				}),
			);

			// 中文提示渲染在输入框下方
			expect(html).toContain('短码已被其他 Agent 占用，请改用其他短码');
			// 英文进入可展开技术详情
			expect(html).toContain('技术详情');
			expect(html).toContain(
				'Monogram &quot;CL&quot; is already in use by agent &quot;claude&quot;.',
			);
			expect(html).toContain('aria-invalid="true"');
		});
	});

	// ─── R6 & E-185: monogram 纯文本渲染，不引任何资源文件 ───
	describe('R6 & E-185: 纯文本 monogram chip，不引用任何静态资源', () => {
		const mockAgent: AgentEntryWithLayers = {
			id: 'custom-6',
			name: 'Sixth Agent',
			monogram: 'S6',
			isAvailable: true,
			defaultModel: null,
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: 'custom6',
		};

		it('renders monogram chip using plain text and contains zero image assets', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: 'S6',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
				}),
			);

			// 验证纯文本渲染
			expect(html).toContain('data-testid="monogram-chip-custom-6"');
			expect(html).toContain('>S6<');
			// 断言绝不包含外部图片、svg 图标资产引用
			expect(html).not.toContain('<img');
			expect(html).not.toContain('<image');
			expect(html).not.toContain('.png');
			expect(html).not.toContain('.svg');
		});
	});

	// ─── R5 & AC 8 / E-248: 任务并行窗口数与定位不到不渲染写入口 ───
	describe('R5 & AC 8 / E-248: 并行窗口数与目标文档定位', () => {
		it('renders lane count setting with stepper buttons when targetDoc is identified', () => {
			expect(DEFAULT_LANE_COUNT).toBe(2);
			expect(MIN_LANE_COUNT).toBe(1);
			expect(MAX_LANE_COUNT).toBe(6);

			const html = renderToStaticMarkup(
				createElement(LaneCountSetting, {
					laneCount: 2,
					hasTargetDoc: true,
					targetDocName: '主项目',
					onChangeLaneCount: vi.fn(),
				}),
			);

			expect(html).toContain('任务并行窗口数');
			expect(html).toContain('文档：主项目');
			expect(html).toContain('此值只属于调度器，与阅读器互不影响');
			expect(html).toContain('lane-count-decrease-btn');
			expect(html).toContain('lane-count-increase-btn');
		});

		it('does NOT render write stepper buttons when target doc is not identified (R5)', () => {
			const html = renderToStaticMarkup(
				createElement(LaneCountSetting, {
					laneCount: 2,
					hasTargetDoc: false,
				}),
			);

			expect(html).toContain('任务并行窗口数');
			expect(html).toContain('此值只属于调度器，与阅读器互不影响');
			// R5: 未定位到目标文档时不渲染写入口
			expect(html).not.toContain('lane-count-decrease-btn');
			expect(html).not.toContain('lane-count-increase-btn');
			expect(html).toContain('未定位到目标文档，仅显示当前值');
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

		it('keeps the container free of colour / font-size / radius utilities (R7)', async () => {
			// 规则管的是容器源码本身：颜色、字号、圆角一律不写在 features/ 容器里。
			const { readFileSync } = await import('node:fs');
			const source = readFileSync(
				new URL('../src/features/settings-agents/settings-agents-container.tsx', import.meta.url),
				'utf8',
			);

			const forbidden =
				/(text-(ink|meta|dense|lead|micro|down|needs|auto|on-)|bg-(down|needs|auto|panel|page|bg)|border-(down|needs|auto|strong)|font-(ui|mono)|rounded)/;
			expect(source).not.toMatch(forbidden);
			// 但加载态仍由展示层渲染
			expect(source).toContain('InlineNotice');
		});

		it('keeps components/ free of reverse imports from features/ (R7)', async () => {
			const { readdirSync, readFileSync } = await import('node:fs');
			const dir = new URL('../src/components/', import.meta.url);
			const offenders: string[] = [];
			for (const name of readdirSync(dir)) {
				if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue;
				const source = readFileSync(new URL(name, dir), 'utf8');
				if (/from\s+'[^']*features\//.test(source)) offenders.push(name);
			}
			expect(offenders).toEqual([]);
		});
	});

	// ─── R4 余量：模型与权限档字段错也要就地渲染 ───
	describe('R4: model and permissionTier field errors render below their own control', () => {
		const mockAgent: AgentEntryWithLayers = {
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			isAvailable: true,
			defaultModel: 'gpt-4o',
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: 'codex',
		};

		it('renders the defaultModel error under the model picker in Chinese, with technical detail folded', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: ['gpt-4o'],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: '—',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
					validationError: {
						defaultModel: {
							message: '模型名不被该 agent 接受，请换一个',
							technical: 'model "gpt-4o" is not in the catalog',
							requestId: 'req-9',
						},
					},
				}),
			);

			expect(html).toContain('data-testid="model-field-error"');
			expect(html).toContain('模型名不被该 agent 接受，请换一个');
			expect(html).toContain('技术详情');
			expect(html).toContain('is not in the catalog');
		});

		it('renders the permissionTier error under the select', () => {
			const html = renderToStaticMarkup(
				createElement(AgentCard, {
					agent: mockAgent,
					models: [],
					getFieldLayers: (_agent, field) => ({
						key: field,
						label: field,
						builtIn: '—',
						override: null,
						effective: '—',
					}),
					onUpdateField: vi.fn().mockResolvedValue(true),
					onProbe: vi.fn().mockResolvedValue(undefined),
					validationError: {
						permissionTier: { message: '权限档不被接受，请改选其他档位' },
					},
				}),
			);

			expect(html).toContain('data-testid="permissionTier-error-codex"');
			expect(html).toContain('权限档不被接受，请改选其他档位');
		});
	});
});
