import { useCallback, useEffect, useState } from 'react';
import type {
	ListAgentsResponse,
	ProbeAgentResponse,
	UpdateAgentBody,
	UpdateAgentResponse,
} from '../../../../shared/src/api/agents.ts';
import type {
	ListDocumentsResponse,
	UpdateDocumentSettingsResponse,
} from '../../../../shared/src/api/documents.ts';
import { httpClient } from '../../api/http-client.ts';
import {
	type AgentFieldKey,
	BUILT_IN_AGENT_CONFIGS,
	type BuiltInAgentId,
	DEFAULT_LANE_COUNT,
	type FieldLayerValues,
	MAX_LANE_COUNT,
	MIN_LANE_COUNT,
	type RegisteredAgentItem,
} from './types.ts';

export interface UseSettingsAgentsResult {
	readonly agents: readonly RegisteredAgentItem[];
	readonly isLoading: boolean;
	readonly error: Error | null;
	readonly laneCount: number;
	readonly laneCountError: string | null;
	readonly probingAgentId: string | null;
	readonly updatingAgentId: string | null;
	readonly validationErrors: Readonly<Record<string, Partial<Record<AgentFieldKey, string>>>>;
	readonly loadAgents: () => Promise<void>;
	readonly probeAgent: (agentId: string) => Promise<ProbeAgentResponse | undefined>;
	readonly updateAgentField: (
		agentId: string,
		field: AgentFieldKey,
		value: string | number,
	) => Promise<boolean>;
	readonly restoreDefaultField: (agentId: string, field: AgentFieldKey) => Promise<boolean>;
	readonly adoptDefaultField: (agentId: string, field: AgentFieldKey) => Promise<boolean>;
	readonly setLaneCount: (count: number) => Promise<void>;
	readonly addCustomAgent: (params: {
		readonly id: string;
		readonly name: string;
		readonly monogram: string;
		readonly execPath: string;
		readonly defaultModel?: string | null;
		readonly maxConcurrency?: number;
		readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	}) => Promise<boolean>;
	readonly getFieldLayers: (agent: RegisteredAgentItem, field: AgentFieldKey) => FieldLayerValues;
	readonly validateMonogram: (
		agentId: string,
		monogram: string,
	) => { readonly valid: boolean; readonly message?: string };
}

function getBuiltInConfig(id: string) {
	return Object.prototype.hasOwnProperty.call(BUILT_IN_AGENT_CONFIGS, id)
		? BUILT_IN_AGENT_CONFIGS[id as BuiltInAgentId]
		: undefined;
}

export function useSettingsAgents(): UseSettingsAgentsResult {
	const [agents, setAgents] = useState<readonly RegisteredAgentItem[]>([]);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [error, setError] = useState<Error | null>(null);

	// Lane count state (AC 8, E-248: default 2, range 1-6)
	const [laneCount, setLaneCountState] = useState<number>(DEFAULT_LANE_COUNT);
	const [activeDocId, setActiveDocId] = useState<string | null>(null);
	const [laneCountError, setLaneCountError] = useState<string | null>(null);

	const [probingAgentId, setProbingAgentId] = useState<string | null>(null);
	const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null);
	const [validationErrors, setValidationErrors] = useState<
		Record<string, Partial<Record<AgentFieldKey, string>>>
	>({});

	// Load document laneCount and documents list
	const loadDocuments = useCallback(async () => {
		try {
			const res = await httpClient.get<ListDocumentsResponse>('/api/v1/documents');
			if (res.documents.length > 0) {
				const doc = res.documents[0];
				if (doc) {
					setActiveDocId(doc.id);
					if (doc.laneCount >= MIN_LANE_COUNT && doc.laneCount <= MAX_LANE_COUNT) {
						setLaneCountState(doc.laneCount);
					}
				}
			}
		} catch {
			// If documents endpoint fails or is unavailable, lane count retains default 2 (E-248)
		}
	}, []);

	// Load agents list from daemon (GET /api/v1/agents)
	const loadAgents = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const response = await httpClient.get<ListAgentsResponse>('/api/v1/agents');
			// Map to RegisteredAgentItem, preserving defaultUpdates & warnings
			const mapped: RegisteredAgentItem[] = response.agents.map((dto) => {
				const builtIn = getBuiltInConfig(dto.id);
				const overrides: Partial<Record<AgentFieldKey, string | number>> = {};

				if (builtIn) {
					if (dto.monogram !== builtIn.monogram) {
						overrides.monogram = dto.monogram;
					}
					if (dto.execPath && dto.execPath !== builtIn.execPath) {
						overrides.execPath = dto.execPath;
					}
					if (dto.defaultModel !== builtIn.defaultModel) {
						overrides.defaultModel = dto.defaultModel ?? undefined;
					}
					if (dto.maxConcurrency !== builtIn.maxConcurrency) {
						overrides.maxConcurrency = dto.maxConcurrency;
					}
					if (dto.permissionTier !== builtIn.permissionTier) {
						overrides.permissionTier = dto.permissionTier;
					}
				}

				return {
					...dto,
					overrides,
				};
			});
			setAgents(mapped);
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
			setProbingAgentId(agentId);
			try {
				const res = await httpClient.post<ProbeAgentResponse>(
					`/api/v1/agents/${encodeURIComponent(agentId)}/probe`,
				);
				// Refresh agents list after probing to reflect latest availability
				await loadAgents();
				return res;
			} catch {
				// Re-load agents to sync latest error status from daemon
				await loadAgents();
				return undefined;
			} finally {
				setProbingAgentId(null);
			}
		},
		[loadAgents],
	);

	// Update single agent field (PATCH /api/v1/agents/:agentId)
	const updateAgentField = useCallback(
		async (agentId: string, field: AgentFieldKey, value: string | number): Promise<boolean> => {
			// Validation check for monogram (E-183)
			if (field === 'monogram') {
				const strVal = String(value);
				const valCheck = validateMonogram(agentId, strVal);
				if (!valCheck.valid) {
					setValidationErrors((prev) => ({
						...prev,
						[agentId]: {
							...prev[agentId],
							monogram: valCheck.message,
						},
					}));
					return false;
				}
				// Clear monogram error without delete operator
				setValidationErrors((prev) => {
					if (!prev[agentId]?.monogram) return prev;
					const { monogram: _unused, ...rest } = prev[agentId] ?? {};
					return {
						...prev,
						[agentId]: rest,
					};
				});
			}

			setUpdatingAgentId(agentId);
			const updates: UpdateAgentBody = {
				[field]: value,
			};

			try {
				const res = await httpClient.patch<UpdateAgentResponse, UpdateAgentBody>(
					`/api/v1/agents/${encodeURIComponent(agentId)}`,
					updates,
				);
				// Update local state
				setAgents((prev) =>
					prev.map((a) => {
						if (a.id !== agentId) return a;
						const builtIn = getBuiltInConfig(agentId);
						const nextOverrides = { ...(a.overrides ?? {}) };
						if (builtIn && builtIn[field as keyof typeof builtIn] === value) {
							delete nextOverrides[field];
						} else {
							nextOverrides[field] = value;
						}
						return {
							...a,
							...res.agent,
							overrides: nextOverrides,
						};
					}),
				);
				return true;
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				setValidationErrors((prev) => ({
					...prev,
					[agentId]: {
						...prev[agentId],
						[field]: e.message,
					},
				}));
				return false;
			} finally {
				setUpdatingAgentId(null);
			}
		},
		[validateMonogram],
	);

	// Restore field to built-in default (AC 1, E-92)
	const restoreDefaultField = useCallback(
		async (agentId: string, field: AgentFieldKey): Promise<boolean> => {
			const builtIn = getBuiltInConfig(agentId);
			if (!builtIn) {
				// Custom agent: clear override
				setAgents((prev) =>
					prev.map((a) => {
						if (a.id !== agentId) return a;
						const nextOverrides = { ...(a.overrides ?? {}) };
						delete nextOverrides[field];
						return { ...a, overrides: nextOverrides };
					}),
				);
				return true;
			}

			const defaultValue = builtIn[field as keyof typeof builtIn];
			if (defaultValue === undefined) return false;

			const success = await updateAgentField(agentId, field, defaultValue as string | number);
			if (success) {
				// Clear override tracking
				setAgents((prev) =>
					prev.map((a) => {
						if (a.id !== agentId) return a;
						const nextOverrides = { ...(a.overrides ?? {}) };
						delete nextOverrides[field];
						return { ...a, overrides: nextOverrides };
					}),
				);
			}
			return success;
		},
		[updateAgentField],
	);

	// Adopt updated built-in default (E-92)
	const adoptDefaultField = useCallback(
		async (agentId: string, field: AgentFieldKey): Promise<boolean> => {
			const targetAgent = agents.find((a) => a.id === agentId);
			const notice = targetAgent?.defaultUpdates?.find((u) => u.field === field);
			if (!notice) return false;

			const success = await updateAgentField(agentId, field, notice.newValue);
			if (success) {
				// Clear the default update notice
				setAgents((prev) =>
					prev.map((a) => {
						if (a.id !== agentId) return a;
						const nextUpdates = (a.defaultUpdates ?? []).filter((u) => u.field !== field);
						return {
							...a,
							defaultUpdates: nextUpdates,
						};
					}),
				);
			}
			return success;
		},
		[agents, updateAgentField],
	);

	// Set lane count (AC 8, E-248: 1-6)
	const setLaneCount = useCallback(
		async (count: number) => {
			if (count < MIN_LANE_COUNT || count > MAX_LANE_COUNT) {
				setLaneCountError(`并行窗口数必须在 ${MIN_LANE_COUNT} 到 ${MAX_LANE_COUNT} 之间`);
				return;
			}
			setLaneCountError(null);
			setLaneCountState(count);

			if (activeDocId) {
				try {
					await httpClient.patch<UpdateDocumentSettingsResponse, { laneCount: number }>(
						`/api/v1/documents/${encodeURIComponent(activeDocId)}/settings`,
						{ laneCount: count },
					);
				} catch {
					// Fallback to local memory state
				}
			}
		},
		[activeDocId],
	);

	// Add 5th/6th custom agent (AC 7, E-185: only needs 2-char monogram, no new assets)
	const addCustomAgent = useCallback(
		async (params: {
			readonly id: string;
			readonly name: string;
			readonly monogram: string;
			readonly execPath: string;
			readonly defaultModel?: string | null;
			readonly maxConcurrency?: number;
			readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
		}): Promise<boolean> => {
			// Validate monogram uniqueness
			const monogramCheck = validateMonogram(params.id, params.monogram);
			if (!monogramCheck.valid) {
				setValidationErrors((prev) => ({
					...prev,
					[params.id]: {
						monogram: monogramCheck.message,
					},
				}));
				return false;
			}

			// Add to local state (registered agent item)
			const newAgent: RegisteredAgentItem = {
				id: params.id,
				name: params.name,
				monogram: params.monogram.toUpperCase(),
				isAvailable: true,
				defaultModel: params.defaultModel ?? null,
				maxConcurrency: params.maxConcurrency ?? 1,
				permissionTier: params.permissionTier ?? 'workspaceWrite',
				execPath: params.execPath,
				overrides: {},
			};

			setAgents((prev) => [...prev, newAgent]);
			return true;
		},
		[validateMonogram],
	);

	// Helper to extract 3-row layer values (内置默认 / 你的覆盖 / 当前生效) (AC 1, E-92)
	const getFieldLayers = useCallback(
		(agent: RegisteredAgentItem, field: AgentFieldKey): FieldLayerValues => {
			const builtInConfig = getBuiltInConfig(agent.id);
			let builtInVal = '—';
			if (builtInConfig) {
				const rawBuiltIn = builtInConfig[field as keyof typeof builtInConfig];
				builtInVal = rawBuiltIn === null || rawBuiltIn === undefined ? '—' : String(rawBuiltIn);
			}

			const overrideVal =
				agent.overrides?.[field] !== undefined ? String(agent.overrides[field]) : null;

			let effectiveVal = '—';
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

			const notice = agent.defaultUpdates?.find((u) => u.field === field);
			const updateNotice = notice ? { oldValue: notice.oldValue, newValue: notice.newValue } : null;

			return {
				key: field,
				label: field,
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
		laneCountError,
		probingAgentId,
		updatingAgentId,
		validationErrors,
		loadAgents,
		probeAgent,
		updateAgentField,
		restoreDefaultField,
		adoptDefaultField,
		setLaneCount,
		addCustomAgent,
		getFieldLayers,
		validateMonogram,
	};
}
