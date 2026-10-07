// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, httpClient } from '../src/api/http-client.ts';
import { clearResourceCache } from '../src/api/resource-cache.ts';
import { AgentCard, type AgentEntryWithLayers } from '../src/components/agent-card.tsx';
import { FieldLayersRow } from '../src/components/field-layers-row.tsx';
import { GateCard, GatePendingBadge } from '../src/components/gate-card.tsx';
import { LoginHint } from '../src/components/login-hint.tsx';
import { PipelineAssignment } from '../src/components/pipeline-assignment.tsx';
import { StreamHeadMeta } from '../src/components/stream-head-meta.tsx';
import { toPipelineSettingsError } from '../src/features/run-deck/use-pipeline-settings.ts';
import { useSettingsAgents } from '../src/features/settings-agents/use-settings-agents.ts';
import { SettingsAgentsPage } from '../src/pages/settings-agents-page.tsx';
import { SettingsPipelinePage } from '../src/pages/settings-pipeline-page.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	clearResourceCache();
	vi.restoreAllMocks();
});

const DISPLAY_FILES = [
	'components/agent-card.tsx',
	'components/assign-panel.tsx',
	'components/pipeline-assignment.tsx',
	'components/model-picker.tsx',
	'components/effort-picker.tsx',
	'ui/grouped-select.tsx',
	'components/login-hint.tsx',
	'components/field-layers-row.tsx',
	'components/gate-card.tsx',
	'components/stream-head-meta.tsx',
	'features/settings-agents/settings-agents-container.tsx',
	'features/settings-agents/use-settings-agents.ts',
	'features/settings-agents/types.ts',
	'pages/settings-agents-page.tsx',
	'pages/settings-pipeline-page.tsx',
	'features/run-deck/use-pipeline-settings.ts',
] as const;

function inspectSource(text: string, file = 'example.tsx') {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const chinese: { line: number; text: string }[] = [];
	const reverseImports: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isTypeNode(node)) return;
		const literalText =
			ts.isJsxText(node) || ts.isStringLiteral(node)
				? node.text.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hex, decimal) => {
						const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
						return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
					})
				: ts.isStringLiteralLike(node) ||
						ts.isTemplateHead(node) ||
						ts.isTemplateMiddle(node) ||
						ts.isTemplateTail(node)
					? node.text
					: '';
		if (
			(ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node) ||
				ts.isJsxText(node)) &&
			/\p{Script=Han}/u.test(literalText)
		) {
			chinese.push({
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				text: node.text,
			});
		}
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			/(?:^|\/)(?:i18n|features)(?:\/|$)/.test(node.moduleSpecifier.text)
		) {
			reverseImports.push(node.moduleSpecifier.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { chinese, reverseImports };
}

describe('M9-T23 Chinese UI source ownership', () => {
	it.each(DISPLAY_FILES)('%s has no runtime Chinese literal', (file) => {
		const text = readFileSync(new NodeURL(`../src/${file}`, import.meta.url), 'utf8');
		expect(inspectSource(text, file).chinese).toEqual([]);
	});

	it.each([
		'const label = "内置默认";',
		'const label = "\\u4f60\\u7684\\u8986\\u76d6";',
		'const view = <button>恢复默认</button>;',
		'const view = <input aria-label="执行 Agent" />;',
		'const view = <input placeholder={"输入名称"} />;',
		'const view = <button>&#x6062;&#22797;&#40664;&#x8ba4;</button>;',
		'const view = <input aria-label="&#x6267;&#34892; Agent" />;',
		'const label = `会话 ${number}`;',
		'const label = `${number} 分钟前探测`;',
		'const label = `${number} 当前已分配 ${limit}`;',
		'const view = <span>{isFull ? " 已满额" : ""}</span>;',
	])('rejects a newly introduced literal: %s', (text) => {
		expect(inspectSource(text).chinese).toHaveLength(1);
	});

	it('accepts comments, UI_STRINGS and props carrying vendor data', () => {
		const text = `
			// 中文注释不是界面文案
			/** 供应商模型名保持原样 */
			type Example = { kind: '仅类型' };
			const view = <div>{/* 中文 JSX 注释 */}
				<button title={UI_STRINGS.agentCard.noOverrideTitle}>
					{UI_STRINGS.agentCard.restoreDefault}
				</button>
				<input placeholder={labels.customActionPlaceholder} />
				<span>{catalog.models[0].name} {value.vendor} {agent.name}</span>
			</div>;
		`;
		expect(inspectSource(text).chinese).toEqual([]);
	});

	it('keeps generic UI imports independent of business text and features', () => {
		const text = readFileSync(new NodeURL('../src/ui/grouped-select.tsx', import.meta.url), 'utf8');
		expect(inspectSource(text).reverseImports).toEqual([]);
		for (const module of ['../i18n/ui-strings.ts', '../features/settings-agents/example.ts']) {
			expect(inspectSource(`import { labels } from '${module}';`).reverseImports).toEqual([module]);
		}
	});
});

describe('M9-T23 mounted reused text and settings feedback', () => {
	it('keeps the Agent settings heading and loading/failure status', async () => {
		let rejectRead: (reason: Error) => void = () => {};
		vi.spyOn(httpClient, 'callRoute').mockReturnValue(
			new Promise((_resolve, reject) => {
				rejectRead = reject;
			}),
		);
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(SettingsAgentsPage)));
			expect(container.querySelector('h1')?.textContent).toBe('Agent 注册表与模型选择');
			expect(container.querySelector('header')?.textContent).toContain('设置');
			expect(container.textContent).toContain('正在加载 Agent 注册表...');
			await act(async () => rejectRead(new Error('vendor read failure')));
			expect(
				container.querySelector('[data-testid="settings-agents-error-notice"]')?.textContent,
			).toContain('加载 Agent 列表失败，请重试');
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it('keeps the pipeline settings heading and failed read wording', async () => {
		vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route) => {
			if (route.path === '/api/v1/agents') return { agents: [] };
			throw new Error('vendor read failure');
		});
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(SettingsPipelinePage)));
			expect(container.querySelector('h1')?.textContent).toBe('流水线设置');
			expect(container.querySelector('header')?.textContent).toContain('设置');
			expect(container.textContent).toContain('读取流水线设置失败，请稍后重试');
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
	it('preserves the command sentence, layer values and upgrade notice in real DOM', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					createElement(
						'div',
						null,
						createElement(LoginHint, {
							login: {
								state: 'logged_out',
								checkedAt: null,
								loginCommand: 'vendor login',
								reason: null,
								warningCode: null,
							},
						}),
						createElement(FieldLayersRow, {
							fieldLabel: '供应商字段',
							layers: {
								key: 'defaultModel',
								label: '供应商字段',
								builtIn: '旧模型',
								override: '自定义模型',
								effective: '自定义模型',
								updateNotice: { oldValue: '旧模型', newValue: '新模型' },
							},
						}),
					),
				),
			);
			expect(container.querySelector('[data-testid="login-hint"] span')?.textContent).toBe(
				'未登录：在终端运行 vendor login 后点刷新',
			);
			expect(container.querySelector('button')?.textContent).toBe('复制命令');
			expect(
				container
					.querySelector('[data-testid="default-updated-notice-defaultModel"]')
					?.textContent?.trim(),
			).toBe('内置默认已更新（旧模型 → 新模型）');
			expect(
				container.querySelector('[data-testid="layer-override-defaultModel"]')?.textContent,
			).toBe('自定义模型');
			for (const label of ['内置默认', '你的覆盖', '当前生效'])
				expect(container.textContent).toContain(label);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it('preserves mismatch titles, vendor strings and Chinese effort normalization', async () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					createElement(StreamHeadMeta, {
						modelName: '所选模型',
						reportedModel: '自报模型',
						effortTier: 'high',
						reportedEffort: '低',
						permissionTier: 'workspaceWrite',
					}),
				),
			);
			expect(container.querySelector('[data-field="model-name"]')?.getAttribute('title')).toBe(
				'自报模型与所选不一致（所选: 所选模型，实际: 自报模型）',
			);
			expect(container.querySelector('[data-field="effort"]')?.getAttribute('title')).toBe(
				'自报思考强度与所选不一致（所选: 高，实际: 低）',
			);
			expect(container.querySelector('[data-field="permission-tier"]')?.getAttribute('title')).toBe(
				'权限档: 工作区',
			);
			await act(async () =>
				root.render(
					createElement(StreamHeadMeta, {
						effort: { vendor: '厂商原值 Ω' },
						reportedEffort: '厂商原值 Ω',
					}),
				),
			);
			expect(container.querySelector('[data-field="effort"]')?.textContent).toBe('厂商原值 Ω');
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it('keeps approval names, jump titles and the three zero-output callbacks', async () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		const approve = vi.fn();
		const edit = vi.fn();
		const reject = vi.fn();
		try {
			await act(async () =>
				root.render(
					createElement(
						'div',
						null,
						createElement(GateCard, {
							gateKind: 'dispatch',
							taskKey: 'M9-T23',
							stepNumber: 2,
							onStepClick: vi.fn(),
							onApprove: approve,
							onEdit: edit,
							onReject: reject,
						}),
						createElement(GatePendingBadge, { count: 3, onClick: vi.fn() }),
					),
				),
			);
			expect(container.querySelector('[data-action="approve"]')?.textContent?.trim()).toBe(
				'批准派发',
			);
			expect(
				container.querySelector('[aria-label="有 3 项待处理审批"]')?.getAttribute('title'),
			).toBe('当前有 3 项待处理审批，点击查看');
			expect(container.querySelector('[title="跳转回产出该审批的步骤（第 2 步）"]')).not.toBeNull();
			expect(container.textContent).toContain('任务 M9-T23：批准派发任务并启动执行');
			expect(container.textContent).toContain('无人应答不会自动批准，任务保持等待');
			await act(async () =>
				root.render(
					createElement(GateCard, {
						context: { exitCode: 1, stderrTail: { kind: 'lines', lines: ['vendor stderr'] } },
						onApprove: approve,
						onEdit: edit,
						onReject: reject,
					}),
				),
			);
			for (const [action, label, callback] of [
				['approve', '重跑', approve],
				['edit', '换 agent 重派', edit],
				['reject', '标失败', reject],
			] as const) {
				const button = container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
				expect(button?.textContent?.trim()).toBe(label);
				await act(async () => button?.click());
				expect(callback).toHaveBeenCalledOnce();
			}
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it('keeps the exact pipeline error dot path beside its labelled control', async () => {
		const parsed = toPipelineSettingsError(
			new ApiError({
				code: 'E_VALIDATION',
				message: 'vendor validation',
				requestId: 'req-example',
				details: { field: 'reviewOverride.agentId' },
			}),
			'fallback',
		);
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					createElement(PipelineAssignment, {
						reviewOverride: { agentId: '', modelName: null, effortTier: null },
						wrapupAssignment: { mode: 'follow' },
						onChangeReviewOverride: vi.fn(),
						onChangeWrapupAssignment: vi.fn(),
						errors: parsed.fieldErrors,
					}),
				),
			);
			expect(parsed.field).toBe('reviewOverride.agentId');
			expect(
				container.querySelector('[data-testid="error-reviewOverride-agentId"]')?.textContent,
			).toBe('输入参数不合规，请检查后重试');
			expect(
				container.querySelector('label[for="review-override-agent-select"]')?.textContent,
			).toBe('执行 Agent');
			expect(
				container.querySelector('#review-override-agent-select')?.getAttribute('aria-invalid'),
			).toBe('true');
			expect(parsed.technical).toBe('E_VALIDATION · vendor validation · requestId=req-example');
			expect(
				toPipelineSettingsError(
					new ApiError({
						code: 'E_PIPELINE_STAGE_DISABLED',
						message: 'disabled',
						requestId: 'req-example',
						details: { stage: 'review' },
					}),
					'fallback',
				).message,
			).toBe('当前流水线阶段已停用（审查）');
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it.each([
		['E_VALIDATION', '输入参数校验失败，请检查修改后重试'],
		['E_NOT_FOUND', '未找到对应配置项'],
		['E_UNAUTHORIZED', '设备未授权，请先完成配对'],
		['E_DEVICE_REVOKED', '设备已被吊销'],
		['E_INTERNAL', '服务内部异常，请稍后重试'],
		['E_AGENT_UNAVAILABLE', '当前 Agent 不可用'],
		['E_AGENT_VERSION_UNRECOGNIZED', 'Agent 版本未识别'],
		['E_FUTURE_CODE', '清除覆盖失败，请重试'],
	])('keeps failed clearOverrides value and the settings wording for %s', async (code, message) => {
		const agent: AgentEntryWithLayers = {
			id: 'vendor-example',
			name: '供应商名',
			monogram: 'VE',
			isAvailable: true,
			defaultModel: '原覆盖模型',
			defaultEffortTier: null,
			maxConcurrency: 1,
			permissionTier: 'workspaceWrite',
			execPath: '/vendor',
			layers: {
				defaultModel: {
					builtin: '内置模型',
					config: null,
					override: '原覆盖模型',
					hasOverride: true,
				},
				defaultEffortTier: { builtin: null, config: null, override: null, hasOverride: false },
			},
		};
		vi.spyOn(httpClient, 'callRoute')
			.mockResolvedValueOnce({ agents: [agent] })
			.mockRejectedValueOnce(
				new ApiError({
					code: code as ApiError['code'],
					message: 'vendor error',
					requestId: 'req-example',
				}),
			);
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		function View() {
			const state = useSettingsAgents();
			const current = state.agents[0];
			return current
				? createElement(AgentCard, {
						agent: current,
						getFieldLayers: state.getFieldLayers,
						onUpdateField: state.updateAgentField,
						onProbe: state.probeAgent,
						onClearOverride: state.clearAgentOverride,
						models: [],
						validationError: state.validationErrors[current.id],
					})
				: null;
		}
		try {
			await act(async () => root.render(createElement(View)));
			const restore = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
				(button) => button.textContent === '恢复默认',
			);
			expect(restore?.disabled).toBe(false);
			await act(async () => restore?.click());
			expect(container.textContent).toContain(message);
			expect(
				container.querySelector('[data-testid="layer-override-defaultModel"]')?.textContent,
			).toBe('原覆盖模型');
			expect(
				container.querySelector('[data-testid="layer-effective-defaultModel"]')?.textContent,
			).toBe('原覆盖模型');
			expect(httpClient.callRoute).toHaveBeenLastCalledWith(
				expect.objectContaining({ method: 'PATCH' }),
				{ params: { agentId: 'vendor-example' }, body: { clearOverrides: ['defaultModel'] } },
			);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
