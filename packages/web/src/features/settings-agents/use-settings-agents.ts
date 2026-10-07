import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	EffortValue,
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
import { invalidateForEvent } from '../../api/cache-invalidation.ts';
import { CACHE_KEYS } from '../../api/cache-keys.ts';
import { eventBus } from '../../api/event-bus.ts';
import { isApiError } from '../../api/http-client.ts';
import { httpClient } from '../../api/http-client.ts';
import { invalidate, peek, read, subscribeResourceCache } from '../../api/resource-cache.ts';
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
import { getSettingsAgentErrorMessage } from '../../i18n/error-messages.ts';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';
import { FIELD_LABELS } from './types.ts';

export interface UseSettingsAgentsOptions {
	readonly targetDocId?: string | null;
}

export type AgentSettingKey = AgentFieldKey | 'defaultEffortTier';

export interface UseSettingsAgentsResult {
	readonly agents: readonly AgentEntryWithLayers[];
	readonly isLoading: boolean;
	readonly error: Error | null;
	readonly laneCount: number;
	readonly documents: readonly DocumentDto[];
	readonly targetDocId: string | null;
	readonly selectTargetDoc: (docId: string) => void;
	readonly isSavingLaneCount: boolean;
	readonly hasTargetDoc: boolean;
	readonly targetDocName: string | null;
	readonly laneCountError: string | null;
	readonly probingAgentId: string | null;
	readonly updatingAgentId: string | null;
	readonly validationErrors: Readonly<
		Record<string, Partial<Record<AgentSettingKey, FieldErrorInfo>>>
	>;
	readonly loadAgents: () => Promise<void>;
	readonly probeAgent: (agentId: string) => Promise<ProbeAgentResponse | undefined>;
	readonly updateAgentField: (
		agentId: string,
		field: AgentFieldKey,
		value: string | number,
	) => Promise<boolean>;
	readonly clearAgentOverride: (
		agentId: string,
		field: 'defaultModel' | 'defaultEffortTier',
	) => Promise<boolean>;
	readonly updateAgentEffortTier: (agentId: string, value: EffortValue) => Promise<boolean>;
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
	const mounted = useRef(true);
	const [agents, setAgents] = useState<readonly AgentEntryWithLayers[]>([]);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [error, setError] = useState<Error | null>(null);

	const [documents, setDocuments] = useState<readonly DocumentDto[]>([]);
	const [selectedDocId, setSelectedDocId] = useState(resolveLastDocId);
	const explicitDocId = options?.targetDocId ?? selectedDocId;
	const targetDoc = documents.find((doc) => doc.id === explicitDocId) ?? null;
	const laneCount = targetDoc?.laneCount ?? DEFAULT_LANE_COUNT;
	const [laneCountError, setLaneCountError] = useState<string | null>(null);
	const [isSavingLaneCount, setIsSavingLaneCount] = useState(false);
	const savingLaneCount = useRef(false);

	const [probingAgentId, setProbingAgentId] = useState<string | null>(null);
	const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null);
	const [validationErrors, setValidationErrors] = useState<
		Record<string, Partial<Record<AgentSettingKey, FieldErrorInfo>>>
	>({});

	// 文档列表只提供选择项；写目标必须来自显式指派、用户选择或已记住的选择。
	const loadDocuments = useCallback(async () => {
		if (!listDocumentsRoute) return;

		try {
			// R7: 请求改走 ROUTES/callRoute
			const res = await httpClient.callRoute<ListDocumentsResponse>(listDocumentsRoute);
			if (mounted.current) setDocuments(res.documents);
		} catch {
			if (mounted.current) setDocuments([]);
		}
	}, []);

	const selectTargetDoc = useCallback(
		(docId: string) => {
			if (savingLaneCount.current || !documents.some((doc) => doc.id === docId)) return;
			setSelectedDocId(docId);
			setLaneCountError(null);
			try {
				const raw = localStorage.getItem('agsched.ui.v1');
				const stored = raw ? JSON.parse(raw) : null;
				const prefs = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
				localStorage.setItem('agsched.ui.v1', JSON.stringify({ ...prefs, lastDocId: docId }));
			} catch {
				// 存储不可用时，当前会话仍可选择文档并保存服务端设置。
			}
		},
		[documents],
	);

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
			const response = await read(CACHE_KEYS.agents(), () =>
				httpClient.callRoute<ListAgentsResponse>(listAgentsRoute),
			);
			if (mounted.current) setAgents(response.agents);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			if (mounted.current) setError(e);
		} finally {
			if (mounted.current) setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		const unsubscribeCache = subscribeResourceCache(() => {
			const response = peek<ListAgentsResponse>(CACHE_KEYS.agents());
			if (response) setAgents(response.agents);
		});
		const unsubscribeEvents = eventBus.subscribeMilestone((event) => {
			if (event.kind === 'document.settings_changed') {
				void loadDocuments();
				return;
			}
			if (event.kind !== 'agent.availability_changed') return;
			invalidateForEvent(event.kind);
			void loadAgents();
		});
		return () => {
			mounted.current = false;
			unsubscribeCache();
			unsubscribeEvents();
		};
	}, [loadAgents, loadDocuments]);

	useEffect(() => {
		void loadAgents();
		void loadDocuments();
	}, [loadAgents, loadDocuments]);

	// Validate monogram uniqueness (E-183)
	const validateMonogram = useCallback(
		(agentId: string, monogram: string): { readonly valid: boolean; readonly message?: string } => {
			const clean = monogram.trim();
			if (clean.length !== 2) {
				return { valid: false, message: UI_STRINGS.settingsAgents.monogramLength };
			}
			const targetLower = clean.toLowerCase();
			for (const other of agents) {
				if (other.id !== agentId && other.monogram.toLowerCase() === targetLower) {
					const otherName = other.name || other.id;
					return {
						valid: false,
						message: UI_STRINGS.settingsAgents.monogramConflict(clean, otherName),
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
				invalidate(CACHE_KEYS.agents());
				await loadAgents();
				return res;
			} catch {
				invalidate(CACHE_KEYS.agents());
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
							monogram: { message: valCheck.message || UI_STRINGS.settingsAgents.monogramInvalid },
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
				invalidate(CACHE_KEYS.agents());
				await loadAgents();
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
				const chineseMsg = getSettingsAgentErrorMessage(
					code,
					UI_STRINGS.settingsAgents.updateFailed,
				);
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
		[agents, validateMonogram, loadAgents],
	);

	// 清除覆盖（AC 7 / E-358: 失败保持原值不乐观清空）
	const clearAgentOverride = useCallback(
		async (agentId: string, field: 'defaultModel' | 'defaultEffortTier'): Promise<boolean> => {
			const prevAgent = agents.find((a) => a.id === agentId);
			if (!prevAgent) return false;

			setUpdatingAgentId(agentId);
			try {
				if (!updateAgentRoute) {
					throw new Error('Route PATCH /api/v1/agents/:agentId is missing in ROUTES');
				}
				const res = await httpClient.callRoute<UpdateAgentResponse, UpdateAgentBody>(
					updateAgentRoute,
					{
						params: { agentId },
						body: { clearOverrides: [field] },
					},
				);
				setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...res.agent } : a)));
				invalidate(CACHE_KEYS.agents());
				await loadAgents();
				setValidationErrors((prev) => {
					if (!prev[agentId]?.[field]) return prev;
					const { [field]: _unused, ...rest } = prev[agentId] ?? {};
					return { ...prev, [agentId]: rest };
				});
				return true;
			} catch (err) {
				const apiErr = isApiError(err) ? err : undefined;
				const code = apiErr?.code ?? 'E_INTERNAL';
				const chineseMsg = getSettingsAgentErrorMessage(
					code,
					UI_STRINGS.settingsAgents.clearFailed,
				);
				const technicalMsg = err instanceof Error ? err.message : String(err);
				setValidationErrors((prev) => ({
					...prev,
					[agentId]: {
						...prev[agentId],
						[field]: {
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
		[agents, loadAgents],
	);

	// 更新思考强度（AC 7 / E-351 / E-358: defaultEffortTier: null 单独发表示「覆盖为跟随」）
	const updateAgentEffortTier = useCallback(
		async (agentId: string, value: EffortValue): Promise<boolean> => {
			const prevAgent = agents.find((a) => a.id === agentId);
			if (!prevAgent) return false;

			setUpdatingAgentId(agentId);
			try {
				if (!updateAgentRoute) {
					throw new Error('Route PATCH /api/v1/agents/:agentId is missing in ROUTES');
				}
				const res = await httpClient.callRoute<UpdateAgentResponse, UpdateAgentBody>(
					updateAgentRoute,
					{
						params: { agentId },
						body: { defaultEffortTier: value },
					},
				);
				setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...res.agent } : a)));
				invalidate(CACHE_KEYS.agents());
				await loadAgents();
				setValidationErrors((prev) => {
					if (!prev[agentId]?.defaultEffortTier) return prev;
					const { defaultEffortTier: _unused, ...rest } = prev[agentId] ?? {};
					return { ...prev, [agentId]: rest };
				});
				return true;
			} catch (err) {
				const apiErr = isApiError(err) ? err : undefined;
				const code = apiErr?.code ?? 'E_INTERNAL';
				const chineseMsg = getSettingsAgentErrorMessage(
					code,
					UI_STRINGS.settingsAgents.effortFailed,
				);
				const technicalMsg = err instanceof Error ? err.message : String(err);
				setValidationErrors((prev) => ({
					...prev,
					[agentId]: {
						...prev[agentId],
						defaultEffortTier: {
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
		[agents, loadAgents],
	);

	// Set lane count (AC 8, E-248: 1-6) with R4 失败回滚 + inline 报错
	const setLaneCount = useCallback(
		async (count: number) => {
			if (!Number.isInteger(count) || count < MIN_LANE_COUNT || count > MAX_LANE_COUNT) {
				setLaneCountError(UI_STRINGS.settingsAgents.laneCountRange(MIN_LANE_COUNT, MAX_LANE_COUNT));
				return;
			}

			// R5: 定位不到目标文档时不执行写操作
			if (!targetDoc || !updateDocumentSettingsRoute) {
				setLaneCountError(UI_STRINGS.settingsAgents.missingDocument);
				return;
			}

			if (savingLaneCount.current || count === laneCount) return;
			const docId = targetDoc.id;
			const prevCount = laneCount;
			savingLaneCount.current = true;
			setIsSavingLaneCount(true);
			setLaneCountError(null);
			setDocuments((current) =>
				current.map((doc) => (doc.id === docId ? { ...doc, laneCount: count } : doc)),
			);

			try {
				// R7: 请求改走 ROUTES/callRoute
				const response = await httpClient.callRoute<
					UpdateDocumentSettingsResponse,
					{ laneCount: number }
				>(updateDocumentSettingsRoute, {
					params: { docId },
					body: { laneCount: count },
				});
				if (mounted.current) {
					setDocuments((current) =>
						current.map((doc) => (doc.id === docId ? response.document : doc)),
					);
				}
			} catch (err) {
				if (!mounted.current) return;
				// R4: 失败回滚并 inline 报错
				setDocuments((current) =>
					current.map((doc) => (doc.id === docId ? { ...doc, laneCount: prevCount } : doc)),
				);
				const apiErr = isApiError(err) ? err : undefined;
				const code = apiErr?.code ?? 'E_INTERNAL';
				const chineseMsg = getSettingsAgentErrorMessage(
					code,
					UI_STRINGS.settingsAgents.laneCountFailed,
				);
				setLaneCountError(chineseMsg);
			} finally {
				savingLaneCount.current = false;
				if (mounted.current) setIsSavingLaneCount(false);
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
		documents,
		targetDocId: targetDoc?.id ?? null,
		selectTargetDoc,
		isSavingLaneCount,
		hasTargetDoc: Boolean(targetDoc),
		targetDocName: targetDoc?.projectName ?? null,
		laneCountError,
		probingAgentId,
		updatingAgentId,
		validationErrors,
		loadAgents,
		probeAgent,
		updateAgentField,
		clearAgentOverride,
		updateAgentEffortTier,
		setLaneCount,
		getFieldLayers,
		validateMonogram,
	};
}
