/**
 * packages/web/src/features/run-deck/use-assign-panel.ts
 *
 * 零运行四步引导的逐任务指派取数与写回（M9-T18 / AC 1-5, E-108, E-31, E-47, E-52, 决策 136）
 *
 * 规范依据（07 节前端架构）：
 * - features 是唯一允许 import src/api 与订阅 store 的一层；展示层只收 props
 * - 请求一律走 http-client + shared ROUTES 表（指派写回经 api/batches.ts），禁止 URL 字面量
 * - 会话序号、agent 已用／上限／是否满额、有效并发、瓶颈来源、是否越过窗口全部读 daemon 字段；
 *   前端不按数组顺序算序号、不用 Math.min 算并发、字段缺失保持 null 由展示层显示「—」
 * - 用户每次改选后 POST 同一端点整批覆写，并用返回值刷新界面（决策 136）
 */

import type {
	AgentEntryDto,
	ListAgentModelsResponse,
	ListAgentsResponse,
} from '@agent-scheduler/shared/api/agents';
import type {
	AgentCapacityPreview,
	TaskAssignmentDraft as ApiAssignmentDraft,
	BatchAssignmentsResponse,
	ConcurrencyPreview,
	TaskAssignmentDto,
} from '@agent-scheduler/shared/api/batches';
import {
	type DocumentDto,
	type ListDocumentBatchesResponse,
	type ListDocumentTasksResponse,
	type ListDocumentsResponse,
	updateDocumentSettingsBodySchema,
} from '@agent-scheduler/shared/api/documents';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { putAssignments, readAssignments } from '../../api/batches.ts';
import { type ApiError, httpClient, isApiError } from '../../api/http-client.ts';
import type {
	AgentCapacityInfo,
	AssignableAgent,
	ConcurrencyAuditData,
	TaskAssignmentSelection,
	TaskItem,
} from '../../components/assign-panel.tsx';
import type {
	OnboardingBatchOption,
	OnboardingDocOption,
} from '../../components/empty-onboarding.tsx';
import { getErrorMessage } from '../../i18n/error-messages.ts';
import { useSelectionStore } from '../../store/selection-store.ts';

/** 任务分页上限（daemon 契约 maximum: 200），超出时按 cursor 续读。 */
const TASKS_PAGE_LIMIT = 200;
/** 防止异常 cursor 造成无限翻页。 */
const TASKS_MAX_PAGES = 10;
/** 仅列出可指派任务：daemon 已派出／已落地／已移除的任务不接受草稿（M8-T11 putDrafts）。 */
const ASSIGNABLE_TASK_STATE = 'never_dispatched' as const;

const MIN_LANE_COUNT = updateDocumentSettingsBodySchema.properties.laneCount.minimum;
const MAX_LANE_COUNT = updateDocumentSettingsBodySchema.properties.laneCount.maximum;

function findRoute(method: 'GET' | 'PATCH', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const LIST_DOCUMENTS_ROUTE = findRoute('GET', '/api/v1/documents');
const LIST_BATCHES_ROUTE = findRoute('GET', '/api/v1/documents/:docId/batches');
const LIST_TASKS_ROUTE = findRoute('GET', '/api/v1/documents/:docId/tasks');
const LIST_AGENTS_ROUTE = findRoute('GET', '/api/v1/agents');
const LIST_AGENT_MODELS_ROUTE = findRoute('GET', '/api/v1/agents/:agentId/models');
const UPDATE_DOCUMENT_SETTINGS_ROUTE = findRoute('PATCH', '/api/v1/documents/:docId/settings');

/**
 * 取数入口集合。默认实现走 http-client；测试注入替身时也必须走同一组方法名，
 * 保证「界面不含业务判定」的检查不会因为换掉 transport 而失效。
 */
export interface AssignPanelClient {
	listDocuments(): Promise<ListDocumentsResponse>;
	listBatches(docId: string): Promise<ListDocumentBatchesResponse>;
	listTasks(
		docId: string,
		batchId: string,
		cursor: string | null,
	): Promise<ListDocumentTasksResponse>;
	listAgents(): Promise<ListAgentsResponse>;
	listAgentModels(agentId: string): Promise<ListAgentModelsResponse>;
	readAssignments(batchId: string): Promise<BatchAssignmentsResponse>;
	putAssignments(
		batchId: string,
		assignments: readonly ApiAssignmentDraft[],
	): Promise<BatchAssignmentsResponse>;
	updateLaneCount(docId: string, laneCount: number): Promise<void>;
}

export const httpAssignPanelClient: AssignPanelClient = {
	listDocuments: () => httpClient.callRoute<ListDocumentsResponse>(LIST_DOCUMENTS_ROUTE),
	listBatches: (docId) =>
		httpClient.callRoute<ListDocumentBatchesResponse>(LIST_BATCHES_ROUTE, { params: { docId } }),
	listTasks: (docId, batchId, cursor) =>
		httpClient.callRoute<ListDocumentTasksResponse>(LIST_TASKS_ROUTE, {
			params: { docId },
			query: {
				batchId,
				state: ASSIGNABLE_TASK_STATE,
				limit: TASKS_PAGE_LIMIT,
				cursor: cursor ?? undefined,
			},
		}),
	listAgents: () => httpClient.callRoute<ListAgentsResponse>(LIST_AGENTS_ROUTE),
	listAgentModels: (agentId) =>
		httpClient.callRoute<ListAgentModelsResponse>(LIST_AGENT_MODELS_ROUTE, { params: { agentId } }),
	readAssignments: (batchId) => readAssignments(batchId),
	putAssignments: (batchId, assignments) => putAssignments(batchId, assignments),
	updateLaneCount: async (docId, laneCount) => {
		await httpClient.callRoute(UPDATE_DOCUMENT_SETTINGS_ROUTE, {
			params: { docId },
			body: { laneCount },
		});
	},
};

/** 就地提示用的规格化错误（中文文案来自 i18n，英文 message 只进技术详情）。 */
export interface AssignPanelError {
	readonly message: string;
	readonly technical: string;
}

function toPanelError(error: unknown): AssignPanelError {
	if (isApiError(error)) {
		const apiError: ApiError = error;
		return {
			message: getErrorMessage(apiError.code),
			technical: `${apiError.code} · ${apiError.message}${apiError.requestId ? ` · requestId=${apiError.requestId}` : ''}`,
		};
	}
	return {
		message: '加载指派数据失败，请稍后重试',
		technical: error instanceof Error ? error.message : String(error),
	};
}

/** daemon 草稿 → 展示用指派记录（逐字段原样透传，不补算）。 */
function toSelectionMap(
	drafts: readonly TaskAssignmentDto[],
): Readonly<Record<string, TaskAssignmentSelection>> {
	const map: Record<string, TaskAssignmentSelection> = {};
	for (const draft of drafts) {
		map[draft.taskId] = {
			taskId: draft.taskId,
			taskKey: draft.taskKey,
			agentId: draft.agentId,
			model: draft.model,
			effort: draft.effort,
			sessionNo: draft.sessionNo,
		};
	}
	return map;
}

/** 展示用指派记录 → POST 请求体（整批覆写，未列出的任务由 daemon 置空）。 */
function toApiDraft(selection: TaskAssignmentSelection): ApiAssignmentDraft {
	return {
		taskId: selection.taskId,
		agentId: selection.agentId,
		model: selection.model,
		effort: selection.effort,
	};
}

function toAgentCapacityMap(
	agentCapacities: readonly AgentCapacityPreview[],
): Readonly<Record<string, AgentCapacityInfo>> {
	const map: Record<string, AgentCapacityInfo> = {};
	for (const capacity of agentCapacities) {
		map[capacity.agentId] = {
			used: capacity.active,
			max: capacity.limit,
			isFull: capacity.isFull,
		};
	}
	return map;
}

export interface UseAssignPanelOptions {
	/** 只在零运行空态取数：运行甲板有流时不打扰 daemon */
	readonly enabled?: boolean;
	/** 测试注入的取数入口；生产用 httpAssignPanelClient */
	readonly client?: AssignPanelClient;
}

export interface UseAssignPanelResult {
	readonly documents: readonly OnboardingDocOption[];
	readonly batches: readonly OnboardingBatchOption[];
	readonly tasks: readonly TaskItem[];
	readonly agents: readonly AssignableAgent[];
	readonly assignments: Readonly<Record<string, TaskAssignmentSelection>>;
	readonly agentCapacities: Readonly<Record<string, AgentCapacityInfo>>;
	readonly audit: ConcurrencyAuditData;
	readonly selectedDocId: string | null;
	readonly selectedBatchId: string | null;
	readonly isLoading: boolean;
	readonly isSaving: boolean;
	readonly error: AssignPanelError | null;
	readonly isUnlockedAboveWindow: boolean;
	readonly canIncreaseUserSetting: boolean | null;
	readonly canDecreaseUserSetting: boolean | null;
	readonly step3Summary: string;
	readonly selectDoc: (docId: string) => void;
	readonly selectBatch: (batchId: string) => void;
	readonly assignTask: (taskId: string, selection: TaskAssignmentSelection) => Promise<void>;
	readonly resetAssignment: (taskId: string) => Promise<void>;
	readonly changeUserSetting: (laneCount: number) => Promise<void>;
	readonly toggleUnlockAboveWindow: (unlocked: boolean) => void;
	readonly reload: () => Promise<void>;
}

/**
 * 零运行四步引导的取数与写回 Hook（M9-T16 的 step3Slot / step4Slot 数据源）。
 */
export function useAssignPanel({
	enabled = true,
	client = httpAssignPanelClient,
}: UseAssignPanelOptions = {}): UseAssignPanelResult {
	const selectedDocId = useSelectionStore((state) => state.selectedDocId);
	const selectedBatchId = useSelectionStore((state) => state.selectedBatchId);
	const assignments = useSelectionStore((state) => state.assignments);
	const setSelectedDocId = useSelectionStore((state) => state.setSelectedDocId);
	const setSelectedBatchId = useSelectionStore((state) => state.setSelectedBatchId);
	const setAssignments = useSelectionStore((state) => state.setAssignments);

	const [documents, setDocuments] = useState<readonly DocumentDto[]>([]);
	const [batches, setBatches] = useState<readonly OnboardingBatchOption[]>([]);
	const [tasks, setTasks] = useState<readonly TaskDto[]>([]);
	const [agentEntries, setAgentEntries] = useState<readonly AgentEntryDto[]>([]);
	const [modelsByAgent, setModelsByAgent] = useState<Readonly<Record<string, readonly string[]>>>(
		{},
	);
	const [preview, setPreview] = useState<ConcurrencyPreview | null>(null);
	const [isLoading, setIsLoading] = useState<boolean>(enabled);
	const [isSaving, setIsSaving] = useState<boolean>(false);
	const [error, setError] = useState<AssignPanelError | null>(null);
	const [isUnlockedAboveWindow, setIsUnlockedAboveWindow] = useState<boolean>(false);
	/** 旧请求的返回值必须丢弃，避免批次切换时用过期预览覆盖新状态 */
	const requestSeq = useRef(0);

	const applyResponse = useCallback(
		(response: BatchAssignmentsResponse) => {
			setAssignments(toSelectionMap(response.drafts));
			setPreview(response.preview);
		},
		[setAssignments],
	);

	// 1. 文档与 Agent 清单：空态一进入就取，供第一步与第三步共同使用
	useEffect(() => {
		if (!enabled) {
			return;
		}
		let isCurrent = true;
		setIsLoading(true);
		setError(null);
		void (async () => {
			try {
				const [docsResponse, agentsResponse] = await Promise.all([
					client.listDocuments(),
					client.listAgents(),
				]);
				if (!isCurrent) {
					return;
				}
				setDocuments(docsResponse.documents);
				setAgentEntries(agentsResponse.agents);
				setIsLoading(false);
			} catch (loadError) {
				if (!isCurrent) {
					return;
				}
				setError(toPanelError(loadError));
				setIsLoading(false);
			}
		})();
		return () => {
			isCurrent = false;
		};
	}, [client, enabled]);

	// 2. 每个 agent 的模型清单（M4-T6：下拉只列当前 agent 的模型）
	useEffect(() => {
		if (!enabled || agentEntries.length === 0) {
			return;
		}
		let isCurrent = true;
		void (async () => {
			const entries = await Promise.all(
				agentEntries.map(async (agent) => {
					try {
						const response = await client.listAgentModels(agent.id);
						return [agent.id, response.models.map((model) => model.name)] as const;
					} catch {
						// 模型清单取不到就只呈现 daemon 下发的 agent 默认配置，不伪造模型名
						return null;
					}
				}),
			);
			if (!isCurrent) {
				return;
			}
			const next: Record<string, readonly string[]> = {};
			for (const entry of entries) {
				if (entry) {
					next[entry[0]] = entry[1];
				}
			}
			setModelsByAgent(next);
		})();
		return () => {
			isCurrent = false;
		};
	}, [agentEntries, client, enabled]);

	// 3. 选中文档 → 批次清单（第二步按 batch.docId === selectedDocId 联动）
	useEffect(() => {
		if (!enabled || !selectedDocId) {
			setBatches([]);
			return;
		}
		let isCurrent = true;
		void (async () => {
			try {
				const response = await client.listBatches(selectedDocId);
				if (!isCurrent) {
					return;
				}
				setBatches(
					response.batches.map((batch) => ({
						id: batch.id,
						docId: batch.docId,
						name: `第 ${batch.batchNo} 批`,
					})),
				);
			} catch (loadError) {
				if (isCurrent) {
					setError(toPanelError(loadError));
					setBatches([]);
				}
			}
		})();
		return () => {
			isCurrent = false;
		};
	}, [client, enabled, selectedDocId]);

	// 4. 默认选中第一个文档 / 该文档的第一个批次（与 M9-T16 第二步的初始选择一致）
	useEffect(() => {
		if (!enabled) {
			return;
		}
		if (!selectedDocId && documents.length > 0) {
			setSelectedDocId(documents[0]?.id ?? null);
			return;
		}
		if (selectedDocId && batches.length > 0) {
			const stillVisible = batches.some((batch) => batch.id === selectedBatchId);
			if (!stillVisible) {
				setSelectedBatchId(batches[0]?.id ?? null);
			}
		}
	}, [
		batches,
		documents,
		enabled,
		selectedBatchId,
		selectedDocId,
		setSelectedBatchId,
		setSelectedDocId,
	]);

	// 5. 选中批次 → 可指派任务清单（daemon 侧按 batchId + state 过滤）
	useEffect(() => {
		if (!enabled || !selectedDocId || !selectedBatchId) {
			setTasks([]);
			return;
		}
		let isCurrent = true;
		void (async () => {
			try {
				const collected: TaskDto[] = [];
				let cursor: string | null = null;
				for (let page = 0; page < TASKS_MAX_PAGES; page += 1) {
					const response: ListDocumentTasksResponse = await client.listTasks(
						selectedDocId,
						selectedBatchId,
						cursor,
					);
					collected.push(...response.tasks);
					cursor = response.nextCursor;
					if (!cursor) {
						break;
					}
				}
				if (isCurrent) {
					setTasks(collected);
				}
			} catch (loadError) {
				if (isCurrent) {
					setError(toPanelError(loadError));
					setTasks([]);
				}
			}
		})();
		return () => {
			isCurrent = false;
		};
	}, [client, enabled, selectedBatchId, selectedDocId]);

	// 6. 选中批次 → daemon 现算的草稿与并发预览（GET，会话序号与瓶颈的唯一来源）
	const loadAssignments = useCallback(async () => {
		if (!enabled || !selectedBatchId) {
			return;
		}
		const seq = requestSeq.current + 1;
		requestSeq.current = seq;
		try {
			const response = await client.readAssignments(selectedBatchId);
			if (requestSeq.current !== seq) {
				return;
			}
			applyResponse(response);
			setError(null);
		} catch (loadError) {
			if (requestSeq.current === seq) {
				setError(toPanelError(loadError));
			}
		}
	}, [applyResponse, client, enabled, selectedBatchId]);

	useEffect(() => {
		if (!enabled || !selectedBatchId) {
			setPreview(null);
			return;
		}
		void loadAssignments();
	}, [enabled, loadAssignments, selectedBatchId]);

	// 7. 改选后整批覆写：把本地选择并进 daemon 草稿集合，再用返回值刷新
	const writeAssignments = useCallback(
		async (nextSelections: Readonly<Record<string, TaskAssignmentSelection>>) => {
			if (!selectedBatchId) {
				return;
			}
			setIsSaving(true);
			try {
				const response = await client.putAssignments(
					selectedBatchId,
					Object.values(nextSelections).map(toApiDraft),
				);
				applyResponse(response);
				setError(null);
			} catch (writeError) {
				// 写入被拒时保持服务端原状，就地提示原因与改法
				setError(toPanelError(writeError));
			} finally {
				setIsSaving(false);
			}
		},
		[applyResponse, client, selectedBatchId],
	);

	const assignTask = useCallback(
		async (taskId: string, selection: TaskAssignmentSelection) => {
			await writeAssignments({ ...assignments, [taskId]: selection });
		},
		[assignments, writeAssignments],
	);

	const resetAssignment = useCallback(
		async (taskId: string) => {
			const next: Record<string, TaskAssignmentSelection> = { ...assignments };
			delete next[taskId];
			await writeAssignments(next);
		},
		[assignments, writeAssignments],
	);

	const changeUserSetting = useCallback(
		async (laneCount: number) => {
			if (!selectedDocId) {
				return;
			}
			setIsSaving(true);
			try {
				await client.updateLaneCount(selectedDocId, laneCount);
				// 用户设定变了，有效并发与瓶颈由 daemon 重算：重新读预览而不是本地改数字
				await loadAssignments();
				setError(null);
			} catch (writeError) {
				setError(toPanelError(writeError));
			} finally {
				setIsSaving(false);
			}
		},
		[client, loadAssignments, selectedDocId],
	);

	const selectDoc = useCallback(
		(docId: string) => {
			setSelectedDocId(docId);
			setSelectedBatchId(null);
		},
		[setSelectedBatchId, setSelectedDocId],
	);

	const selectBatch = useCallback(
		(batchId: string) => {
			setIsUnlockedAboveWindow(false);
			setSelectedBatchId(batchId);
		},
		[setSelectedBatchId],
	);

	const toggleUnlockAboveWindow = useCallback((unlocked: boolean) => {
		setIsUnlockedAboveWindow(unlocked);
	}, []);

	const onboardingDocuments = useMemo<readonly OnboardingDocOption[]>(
		() =>
			documents.map((document) => ({
				id: document.id,
				title: document.projectName,
				path: document.docsPath,
			})),
		[documents],
	);

	const agentCapacities = useMemo<Readonly<Record<string, AgentCapacityInfo>>>(
		() => (preview ? toAgentCapacityMap(preview.agentCapacities) : {}),
		[preview],
	);

	const agents = useMemo<readonly AssignableAgent[]>(
		() =>
			agentEntries.map((agent) => {
				const capacity = agentCapacities[agent.id];
				return {
					id: agent.id,
					name: agent.name,
					monogram: agent.monogram,
					isAvailable: agent.isAvailable,
					defaultModel: agent.defaultModel,
					// 占用与满额只认 daemon 预览；预览未到显示「—」
					maxConcurrency: capacity?.max ?? null,
					usedConcurrency: capacity ? (capacity.used ?? null) : null,
					isLimitReached: capacity ? (capacity.isFull ?? null) : null,
					supportsEffort: agent.effortVendorMap !== null && agent.effortVendorMap !== undefined,
					models: modelsByAgent[agent.id] ?? undefined,
				};
			}),
		[agentCapacities, agentEntries, modelsByAgent],
	);

	const panelTasks = useMemo<readonly TaskItem[]>(
		() =>
			tasks.map((task) => ({
				id: task.id,
				taskKey: task.taskKey,
				title: task.title,
				moduleKey: task.moduleKey,
			})),
		[tasks],
	);

	const batchOptions = useMemo<readonly OnboardingBatchOption[]>(() => batches, [batches]);

	/**
	 * 调节动作能力：只决定 +/− 与解锁开关是否可点，数值本身不参与任何并发计算。
	 * E-52 规定向上超过并行窗口数必须先显式解锁；窗口数缺失时不放行上调。
	 */
	const windowCount = preview?.windowCount ?? null;
	const userSetting = preview?.userSetting ?? null;
	const canDecreaseUserSetting =
		typeof userSetting === 'number' ? userSetting > MIN_LANE_COUNT : null;
	const canIncreaseUserSetting =
		typeof userSetting === 'number' && typeof windowCount === 'number'
			? userSetting < MAX_LANE_COUNT && (isUnlockedAboveWindow || userSetting < windowCount)
			: null;

	const audit = useMemo<ConcurrencyAuditData>(
		() => ({
			effectiveCapacity: preview?.effectiveConcurrency ?? null,
			windowCount: preview?.windowCount ?? null,
			userSetting: preview?.userSetting ?? null,
			bottleneckSource: preview?.bottleneck ?? null,
			isExceedingWindow: preview?.exceedsWindowCount ?? null,
			isUnlockedAboveWindow,
			agentCapacities: preview
				? preview.agentCapacities.map((capacity) => ({
						agentId: capacity.agentId,
						active: capacity.active,
						limit: capacity.limit,
						drafted: capacity.drafted,
						isFull: capacity.isFull,
					}))
				: [],
		}),
		[isUnlockedAboveWindow, preview],
	);

	const assignedCount = Object.keys(assignments).length;

	return {
		documents: onboardingDocuments,
		batches: batchOptions,
		tasks: panelTasks,
		agents,
		assignments,
		agentCapacities,
		audit,
		selectedDocId,
		selectedBatchId,
		isLoading,
		isSaving,
		error,
		isUnlockedAboveWindow,
		canIncreaseUserSetting,
		canDecreaseUserSetting,
		step3Summary: assignedCount > 0 ? `${assignedCount} 个任务已分别指派` : '',
		selectDoc,
		selectBatch,
		assignTask,
		resetAssignment,
		changeUserSetting,
		toggleUnlockAboveWindow,
		reload: loadAssignments,
	};
}
