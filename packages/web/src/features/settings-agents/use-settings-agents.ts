import { useCallback, useEffect, useState } from 'react';
import type {
	ListAgentsResponse,
	ProbeAgentResponse,
	UpdateAgentBody,
	UpdateAgentResponse,
} from '../../../../shared/src/api/agents.ts';
import type {
	DocumentDto,
	ListDocumentsResponse,
	UpdateDocumentSettingsResponse,
} from '../../../../shared/src/api/documents.ts';
import { ROUTES } from '../../../../shared/src/api/routes.ts';
import { isApiError } from '../../api/http-client.ts';
import { httpClient } from '../../api/http-client.ts';
import type { AgentEntryWithLayers } from '../../components/agent-card.tsx';
import type {
	AgentFieldKey,
	FieldErrorInfo,
	FieldLayerValues,
} from '../../components/field-layers-row.tsx';
import {
	DEFAULT_LANE_COUNT,
	MAX_LANE_COUNT,
	MIN_LANE_COUNT,
} from '../../components/lane-count-setting.tsx';
import { FIELD_LABELS } from './types.ts';

export interface UseSettingsAgentsOptions {
	readonly targetDocId?: string | null;
}

export interface UseSettingsAgentsResult {
	readonly agents: readonly AgentEntryWithLayers[];
	readonly isLoading: boolean;
	readonly error: Error | null;
	readonly laneCount: number;
	readonly hasTargetDoc: boolean;
	readonly targetDocName: string | null;
	readonly laneCountError: string | null;
	readonly probingAgentId: string | null;
	readonly updatingAgentId: string | null;
	readonly validationErrors: Readonly<
		Record<string, Partial<Record<AgentFieldKey, FieldErrorInfo>>>
	>;
	readonly loadAgents: () => Promise<void>;
	readonly probeAgent: (agentId: string) => Promise<ProbeAgentResponse | undefined>;
	readonly updateAgentField: (
		agentId: string,
		field: AgentFieldKey,
		value: string | number,
	) => Promise<boolean>;
	readonly setLaneCount: (count: number) => Promise<void>;
	readonly getFieldLayers: (agent: AgentEntryWithLayers, field: AgentFieldKey) => FieldLayerValues;
	readonly validateMonogram: (
		agentId: string,
		monogram: string,
	) => { readonly valid: boolean; readonly message?: string };
}

const listAgentsRoute = ROUTES.find((r) => r.method === 'GET' && r.path === '/api/v1/agents');
const updateAgentRoute = ROUTES.find(
	(r) => r.method === 'PATCH' && r.path === '/api/v1/agents/:agentId',
);
const probeAgentRoute = ROUTES.find(
	(r) => r.method === 'POST' && r.path === '/api/v1/agents/:agentId/probe',
);
const listDocumentsRoute = ROUTES.find((r) => r.method === 'GET' && r.path === '/api/v1/documents');
const updateDocumentSettingsRoute = ROUTES.find(
	(r) => r.method === 'PATCH' && r.path === '/api/v1/documents/:docId/settings',
);

const ERROR_CODE_CHINESE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
	E_VALIDATION: '输入参数校验失败，请检查修改后重试',
	E_NOT_FOUND: '未找到对应配置项',
	E_UNAUTHORIZED: '设备未授权，请先完成配对',
	E_DEVICE_REVOKED: '设备已被吊销',
	E_INTERNAL: '服务内部异常，请稍后重试',
	E_AGENT_UNAVAILABLE: '当前 Agent 不可用',
	E_AGENT_VERSION_UNRECOGNIZED: 'Agent 版本未识别',
});

function resolveLastDocId(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = localStorage.getItem('agsched.ui.v1');
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed.lastDocId === 'string' && parsed.lastDocId) {
				return parsed.lastDocId;
			}
		}
	} catch {
		// Ignore storage parsing errors
	}
	return null;
}

export function useSettingsAgents(options?: UseSettingsAgentsOptions): UseSettingsAgentsResult {
	const [agents, setAgents] = useState<readonly AgentEntryWithLayers[]>([]);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [error, setError] = useState<Error | null>(null);

	// R5: 窗口数的目标文档由明确来源决定（快照/当前文档），不能取 documents[0]；定位不到不渲染写入口
	const explicitDocId = options?.targetDocId ?? resolveLastDocId();
	const [targetDoc, setTargetDoc] = useState<DocumentDto | null>(null);
	const [laneCount, setLaneCountState] = useState<number>(DEFAULT_LANE_COUNT);
	const [laneCountError, setLaneCountError] = useState<string | null>(null);

	const [probingAgentId, setProbingAgentId] = useState<string | null>(null);
	const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null);
	const [validationErrors, setValidationErrors] = useState<
		Record<string, Partial<Record<AgentFieldKey, FieldErrorInfo>>>
	>({});

	// Load document laneCount strictly from resolved targetDocId
	const loadDocuments = useCallback(async () => {
		if (!explicitDocId || !listDocumentsRoute) {
			setTargetDoc(null);
			return;
		}

		try {
			// R7: 请求改走 ROUTES/callRoute
			const res = await httpClient.callRoute<ListDocumentsResponse>(listDocumentsRoute);
			const found = res.documents.find((d) => d.id === explicitDocId);
			if (found) {
				setTargetDoc(found);
				if (found.laneCount >= MIN_LANE_COUNT && found.laneCount <= MAX_LANE_COUNT) {
					setLaneCountState(found.laneCount);
				}
			} else {
				setTargetDoc(null);
			}
		} catch {
			setTargetDoc(null);
		}
	}, [explicitDocId]);

	// Load agents list from daemon
	const loadAgents = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		if (!listAgentsRoute) {
			setError(new Error('Route GET /api/v1/agents is missing in ROUTES'));
			setIsLoading(false);
			return;
		}

		try {
			// R7: 请求改走 ROUTES/callRoute
			const response = await httpClient.callRoute<ListAgentsResponse>(listAgentsRoute);
			setAgents(response.agents as readonly AgentEntryWithLayers[]);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			setError(e);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadAgents();
		void loadDocuments();
	}, [loadAgents, loadDocuments]);

	// Validate monogram uniqueness (E-183)
	const validateMonogram = useCallback(
		(agentId: string, monogram: string): { readonly valid: boolean; readonly message?: string } => {
			const clean = monogram.trim();
			if (clean.length !== 2) {
				return { valid: false, message: '短码必须为恰好两字符' };
			}
			const targetLower = clean.toLowerCase();
			for (const other of agents) {
				if (other.id !== agentId && other.monogram.toLowerCase() === targetLower) {
					const otherName = other.name || other.id;
					return {
						valid: false,
						message: `短码 "${clean}" 已被 agent "${otherName}" 占用，请改用其他短码`,
					};
				}
			}
			return { valid: true };
		},
		[agents],
	);

	// Probe single agent (POST /api/v1/agents/:agentId/probe)
	const probeAgent = useCallback(
		async (agentId: string): Promise<ProbeAgentResponse | undefined> => {
			if (!probeAgentRoute) return undefined;
			setProbingAgentId(agentId);
			try {
				// R7: 请求改走 ROUTES/callRoute
				const res = await httpClient.callRoute<ProbeAgentResponse>(probeAgentRoute, {
					params: { agentId },
				});
				await loadAgents();
				return res;
			} catch {
				await loadAgents();
				return undefined;
			} finally {
				setProbingAgentId(null);
			}
		},
		[loadAgents],
	);

	// Update single agent field with R4 失败回滚 + 按 error.code/details.field 渲染中文错误
	const updateAgentField = useCallback(
		async (agentId: string, field: AgentFieldKey, value: string | number): Promise<boolean> => {
			if (field === 'monogram') {
				const strVal = String(value);
				const valCheck = validateMonogram(agentId, strVal);
				if (!valCheck.valid) {
					setValidationErrors((prev) => ({
						...prev,
						[agentId]: {
							...prev[agentId],
							monogram: { message: valCheck.message || '短码校验失败' },
						},
					}));
					return false;
				}
				// Clear monogram error
				setValidationErrors((prev) => {
					if (!prev[agentId]?.monogram) return prev;
					const { monogram: _unused, ...rest } = prev[agentId] ?? {};
					return {
						...prev,
						[agentId]: rest,
					};
				});
			}

			const prevAgent = agents.find((a) => a.id === agentId);
			if (!prevAgent) return false;

			setUpdatingAgentId(agentId);

			// Optimistic local update
			setAgents((prev) =>
				prev.map((a) => {
					if (a.id !== agentId) return a;
					return { ...a, [field]: value } as AgentEntryWithLayers;
				}),
			);

			try {
				if (!updateAgentRoute) {
					throw new Error('Route PATCH /api/v1/agents/:agentId is missing in ROUTES');
				}
				// R7: 请求改走 ROUTES/callRoute
				const res = await httpClient.callRoute<UpdateAgentResponse, UpdateAgentBody>(
					updateAgentRoute,
					{
						params: { agentId },
						body: { [field]: value },
					},
				);
				setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...res.agent } : a)));
				// Clear field error on success
				setValidationErrors((prev) => {
					if (!prev[agentId]?.[field]) return prev;
					const { [field]: _unused, ...rest } = prev[agentId] ?? {};
					return { ...prev, [agentId]: rest };
				});
				return true;
			} catch (err) {
				// R4: 失败回滚到之前状态
				setAgents((prev) => prev.map((a) => (a.id === agentId ? prevAgent : a)));
				const apiErr = isApiError(err) ? err : undefined;
				const code = apiErr?.code ?? 'E_INTERNAL';
				const chineseMsg = ERROR_CODE_CHINESE_MESSAGES[code] ?? '配置更新失败，请重试';
				const technicalMsg = err instanceof Error ? err.message : String(err);
				const errorField = (apiErr?.details?.field as AgentFieldKey) || field;

				setValidationErrors((prev) => ({
					...prev,
					[agentId]: {
						...prev[agentId],
						[errorField]: {
							message: chineseMsg,
							technical: technicalMsg,
							requestId: apiErr?.requestId,
						},
					},
				}));
				return false;
			} finally {
				setUpdatingAgentId(null);
			}
		},
		[agents, validateMonogram],
	);

	// Set lane count (AC 8, E-248: 1-6) with R4 失败回滚 + inline 报错
	const setLaneCount = useCallback(
		async (count: number) => {
			if (count < MIN_LANE_COUNT || count > MAX_LANE_COUNT) {
				setLaneCountError(`并行窗口数必须在 ${MIN_LANE_COUNT} 到 ${MAX_LANE_COUNT} 之间`);
				return;
			}

			// R5: 定位不到目标文档时不执行写操作
			if (!targetDoc || !updateDocumentSettingsRoute) {
				setLaneCountError('未定位到目标文档，无法修改窗口数');
				return;
			}

			const prevCount = laneCount;
			setLaneCountError(null);
			setLaneCountState(count);

			try {
				// R7: 请求改走 ROUTES/callRoute
				await httpClient.callRoute<UpdateDocumentSettingsResponse, { laneCount: number }>(
					updateDocumentSettingsRoute,
					{
						params: { docId: targetDoc.id },
						body: { laneCount: count },
					},
				);
			} catch (err) {
				// R4: 失败回滚并 inline 报错
				setLaneCountState(prevCount);
				const apiErr = isApiError(err) ? err : undefined;
				const code = apiErr?.code ?? 'E_INTERNAL';
				const chineseMsg = ERROR_CODE_CHINESE_MESSAGES[code] ?? '更新窗口数失败，已回滚';
				setLaneCountError(chineseMsg);
			}
		},
		[laneCount, targetDoc],
	);

	// Helper to extract 3-row layer values (AC 1, E-92, R1)
	// R1: 三层值只读 AgentEntryDto.layers（不存在则「内置默认」「你的覆盖」显示「—」）
	const getFieldLayers = useCallback(
		(agent: AgentEntryWithLayers, field: AgentFieldKey): FieldLayerValues => {
			const layer = (
				agent.layers as unknown as Record<
					string,
					| {
							readonly builtin?: unknown;
							readonly override?: unknown;
							readonly effective?: unknown;
							readonly hasOverride?: boolean;
					  }
					| undefined
				>
			)?.[field];

			const builtInVal =
				layer?.builtin !== undefined && layer?.builtin !== null ? String(layer.builtin) : '—';

			const overrideVal =
				layer?.override !== undefined && layer?.override !== null
					? String(layer.override)
					: layer?.hasOverride
						? String(layer.override ?? '')
						: '—';

			let effectiveVal = '—';
			if (layer?.effective !== undefined && layer?.effective !== null) {
				effectiveVal = String(layer.effective);
			} else {
				switch (field) {
					case 'monogram':
						effectiveVal = agent.monogram || '—';
						break;
					case 'execPath':
						effectiveVal = agent.execPath || '—';
						break;
					case 'defaultModel':
						effectiveVal = agent.defaultModel || '—';
						break;
					case 'maxConcurrency':
						effectiveVal = String(agent.maxConcurrency);
						break;
					case 'permissionTier':
						effectiveVal = agent.permissionTier || '—';
						break;
				}
			}

			// E-92 的「旧值 → 新值」目前没有任何 daemon 出口（layers 只有 builtin/config/override/hasOverride，
			// defaultUpdates 只在 config/registry.ts 内部快照里），所以本页不自己造差异：
			// 待 daemon 提供升级差异时，由它供给 updateNotice，展示层已经支持渲染。
			const updateNotice = null;

			return {
				key: field,
				label: FIELD_LABELS[field] ?? field,
				builtIn: builtInVal,
				override: overrideVal,
				effective: effectiveVal,
				updateNotice,
			};
		},
		[],
	);

	return {
		agents,
		isLoading,
		error,
		laneCount,
		hasTargetDoc: Boolean(targetDoc),
		targetDocName: targetDoc?.projectName ?? null,
		laneCountError,
		probingAgentId,
		updatingAgentId,
		validationErrors,
		loadAgents,
		probeAgent,
		updateAgentField,
		setLaneCount,
		getFieldLayers,
		validateMonogram,
	};
}
