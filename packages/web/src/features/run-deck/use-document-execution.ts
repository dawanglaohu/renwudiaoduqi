/**
 * 文档执行的取数与控制（M9-T30 / E-360 至 E-369）。
 *
 * 界面只呈现 daemon 的执行 DTO 与能力位。开始、暂停、继续携带点击时观察到的
 * expectedVersion；写请求的响应体不直接改状态。版本冲突只刷新并提示，不换新版本重发。
 */

import type {
	AgentEntryDto,
	ListAgentModelsResponse,
	ListAgentsResponse,
} from '@agent-scheduler/shared/api/agents';
import type { EffortValue } from '@agent-scheduler/shared/api/agents';
import type {
	DocumentDefaultAssignment,
	DocumentExecutionDto,
	DocumentExecutionResponse,
	PauseDocumentExecutionBody,
	ResumeDocumentExecutionBody,
	StartDocumentExecutionBody,
} from '@agent-scheduler/shared/api/document-execution';
import type { DocumentDto, ListDocumentsResponse } from '@agent-scheduler/shared/api/documents';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listAgents, probeAgent } from '../../api/agents.ts';
import { invalidateForEvent } from '../../api/cache-invalidation.ts';
import { CACHE_KEYS } from '../../api/cache-keys.ts';
import {
	getDocumentExecution,
	listExecutionDocuments,
	pauseDocumentExecution,
	refreshExecutionDocument,
	resumeDocumentExecution,
	startDocumentExecution,
} from '../../api/document-execution.ts';
import { eventBus } from '../../api/event-bus.ts';
import { type ApiError, isApiError } from '../../api/http-client.ts';
import { invalidate, read } from '../../api/resource-cache.ts';
import { sseClient } from '../../api/sse-client.ts';
import type { AssignableAgent } from '../../components/assign-panel.tsx';
import { getErrorMessage } from '../../i18n/error-messages.ts';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';
import { useCanDispatch } from '../../store/connection-store.ts';
import { registerResyncHandler } from '../../store/connection-store.ts';
import { useAgentModelCatalogs } from '../settings-agents/use-agent-models.ts';

/** 合同规定的当前代展示额度，不是从历史编号推出来的余量。 */
export const AUTO_WRAPUP_ROUND_QUOTA = 2;
export const PHYSICAL_ATTEMPT_QUOTA = 6;

const SOURCE_CONFIRM_PAUSE_REASONS = new Set([
	'daemon_restarted',
	'doc_changed',
	'source_unreadable',
]);

export function needsSourceConfirmation(pauseReason: string | null | undefined): boolean {
	return typeof pauseReason === 'string' && SOURCE_CONFIRM_PAUSE_REASONS.has(pauseReason);
}

export function shouldAdoptExecution(
	selectedDocId: string | null,
	current: DocumentExecutionDto | null,
	incoming: DocumentExecutionDto,
): boolean {
	if (!selectedDocId || incoming.docId !== selectedDocId) return false;
	if (current && current.docId === selectedDocId && incoming.version < current.version)
		return false;
	return true;
}

export function isExecutionDto(value: unknown): value is DocumentExecutionDto {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<DocumentExecutionDto>;
	return (
		typeof candidate.docId === 'string' &&
		typeof candidate.state === 'string' &&
		typeof candidate.version === 'number' &&
		Array.isArray(candidate.blockers)
	);
}

export function readExecutionPayload(payload: unknown): DocumentExecutionDto | null {
	if (!payload || typeof payload !== 'object') return null;
	if ('truncated' in payload && (payload as { truncated?: unknown }).truncated === true)
		return null;
	const execution = (payload as { execution?: unknown }).execution;
	return isExecutionDto(execution) ? execution : null;
}

export function isVersionConflict(error: ApiError): boolean {
	return error.code === 'E_VALIDATION' && typeof error.details?.actualVersion === 'number';
}

type SnapshotListener = (rows: readonly DocumentExecutionDto[]) => void;
const snapshotListeners = new Set<SnapshotListener>();

/** 重连或首屏快照里的 documentExecutions 交给当前订阅者，不另造状态。 */
export function publishDocumentExecutions(rows: readonly DocumentExecutionDto[]): void {
	// 手机详情可能卸掉面板；快照到达时仍须使同版本旧投影失效。
	for (const row of rows) invalidate(CACHE_KEYS.documentExecutions(row.docId));
	for (const listener of snapshotListeners) listener(rows);
}

// 手机详情会卸掉执行面板，但甲板仍在。另端暂停必须清掉缓存，回到任务或运行流时重新读取。
eventBus.subscribeMilestone((event) => {
	if (
		event.kind === 'document.execution_changed' ||
		event.kind === 'system.docs_changed' ||
		event.kind === 'document.settings_changed' ||
		event.kind === 'agent.availability_changed' ||
		event.kind === 'task.landed' ||
		event.kind === 'batch.advanced'
	) {
		invalidateForEvent(event.kind);
	}
});

export interface DocumentExecutionClient {
	getExecution(docId: string): Promise<DocumentExecutionResponse>;
	start(docId: string, body: StartDocumentExecutionBody): Promise<DocumentExecutionResponse>;
	pause(docId: string, body: PauseDocumentExecutionBody): Promise<DocumentExecutionResponse>;
	resume(docId: string, body: ResumeDocumentExecutionBody): Promise<DocumentExecutionResponse>;
	listDocuments(): Promise<ListDocumentsResponse>;
	refreshDocument(docId: string): Promise<unknown>;
	listAgents(): Promise<ListAgentsResponse>;
	probeAgent(agentId: string): Promise<unknown>;
}

export const httpDocumentExecutionClient: DocumentExecutionClient = {
	getExecution: (docId) =>
		read(CACHE_KEYS.documentExecutions(docId), () => getDocumentExecution(docId)),
	start: startDocumentExecution,
	pause: pauseDocumentExecution,
	resume: resumeDocumentExecution,
	listDocuments: () => read(CACHE_KEYS.documents(), () => listExecutionDocuments()),
	refreshDocument: refreshExecutionDocument,
	listAgents: () => read(CACHE_KEYS.agents(), () => listAgents()),
	probeAgent,
};

export interface DocumentExecutionError {
	readonly message: string;
	readonly technical: string;
}

export interface UseDocumentExecutionResult {
	readonly execution: DocumentExecutionDto | null;
	readonly document: DocumentDto | null;
	readonly documents: readonly DocumentDto[];
	readonly agents: readonly AssignableAgent[];
	readonly assignment: DocumentDefaultAssignment;
	readonly catalog: ListAgentModelsResponse | null;
	readonly isRefreshingModels: boolean;
	readonly pendingAction: string | null;
	readonly error: DocumentExecutionError | null;
	readonly canControl: boolean;
	readonly canStart: boolean;
	readonly canPause: boolean;
	readonly canResume: boolean;
	readonly needsSourceConfirm: boolean;
	readonly sourceConfirmed: boolean;
	readonly setAgentId: (agentId: string) => void;
	readonly setModelName: (modelName: string | null) => void;
	readonly setEffort: (effort: EffortValue) => void;
	readonly start: () => Promise<void>;
	readonly pause: () => Promise<void>;
	readonly resume: () => Promise<void>;
	readonly confirmSource: () => Promise<void>;
	readonly refreshAgent: () => Promise<void>;
}

const EMPTY_ASSIGNMENT: DocumentDefaultAssignment = {
	agentId: '',
	modelName: null,
	effort: null,
};

function toPanelError(error: unknown, message: string): DocumentExecutionError {
	if (isApiError(error)) {
		return {
			message,
			technical: `${error.code} · ${error.message}${error.requestId ? ` · requestId=${error.requestId}` : ''}`,
		};
	}
	return {
		message,
		technical: error instanceof Error ? error.message : String(error),
	};
}

function toAgents(entries: readonly AgentEntryDto[]): readonly AssignableAgent[] {
	return entries.map((agent) => ({
		id: agent.id,
		name: agent.name,
		monogram: agent.monogram,
		isAvailable: agent.isAvailable,
		defaultModel: agent.defaultModel,
		supportsEffort: agent.effortVendorMap !== null && agent.effortVendorMap !== undefined,
		catalog: null,
		currentConfig: null,
		login: agent.login ?? null,
		effortVendorMap: agent.effortVendorMap ?? null,
		effortOptions: agent.effortOptions,
	}));
}

export function useDocumentExecution(
	docId: string | null,
	options: { readonly client?: DocumentExecutionClient } = {},
): UseDocumentExecutionResult {
	const client = options.client ?? httpDocumentExecutionClient;
	const canControl = useCanDispatch();
	const [execution, setExecution] = useState<DocumentExecutionDto | null>(null);
	const [document, setDocument] = useState<DocumentDto | null>(null);
	const [documents, setDocuments] = useState<readonly DocumentDto[]>([]);
	const [agentEntries, setAgentEntries] = useState<readonly AgentEntryDto[]>([]);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [error, setError] = useState<DocumentExecutionError | null>(null);
	const [drafts, setDrafts] = useState<Readonly<Record<string, DocumentDefaultAssignment>>>({});
	const [confirmation, setConfirmation] = useState<{
		readonly docId: string;
		readonly fingerprint: string;
		readonly version: number;
	} | null>(null);

	const docIdRef = useRef(docId);
	const executionRef = useRef(execution);
	const pendingRef = useRef(false);
	const requestSeq = useRef(0);
	const loadSeq = useRef(0);
	const eventSerial = useRef(0);
	const agentLoadSeq = useRef(0);
	docIdRef.current = docId;
	if (execution === null) {
		executionRef.current = null;
	} else if (
		executionRef.current === null ||
		executionRef.current.docId !== execution.docId ||
		execution.version >= executionRef.current.version
	) {
		executionRef.current = execution;
	}

	const currentExecution = execution?.docId === docId ? execution : null;
	const currentDocument = document?.id === docId ? document : null;
	const assignment = useMemo<DocumentDefaultAssignment>(() => {
		if (!docId) return EMPTY_ASSIGNMENT;
		if (
			currentExecution &&
			currentExecution.state !== 'idle' &&
			currentExecution.defaultAssignment
		) {
			return currentExecution.defaultAssignment;
		}
		return drafts[docId] ?? currentExecution?.defaultAssignment ?? EMPTY_ASSIGNMENT;
	}, [docId, drafts, currentExecution]);

	const catalogs = useAgentModelCatalogs(assignment.agentId ? [assignment.agentId] : []);
	const catalogEntry = assignment.agentId ? catalogs[assignment.agentId] : undefined;

	const reload = useCallback(
		async (targetDocId: string) => {
			const serialAtStart = eventSerial.current;
			const seq = ++loadSeq.current;
			const [executionResponse, documentsResponse] = await Promise.all([
				client.getExecution(targetDocId),
				client.listDocuments(),
			]);
			if (seq !== loadSeq.current || docIdRef.current !== targetDocId) return null;
			const nextDocument =
				documentsResponse.documents.find((item) => item.id === targetDocId) ?? null;
			setDocument(nextDocument);
			setDocuments(documentsResponse.documents);
			const incoming = executionResponse.execution;
			if (!isExecutionDto(incoming)) {
				return { document: nextDocument, execution: executionRef.current };
			}
			const current = executionRef.current;
			const keepCurrent =
				!shouldAdoptExecution(targetDocId, current, incoming) ||
				(current !== null &&
					incoming.version === current.version &&
					eventSerial.current !== serialAtStart);
			const next = keepCurrent ? current : incoming;
			if (!keepCurrent) {
				executionRef.current = incoming;
				setExecution(incoming);
			}
			return { document: nextDocument, execution: next };
		},
		[client],
	);

	useEffect(() => {
		requestSeq.current += 1;
		pendingRef.current = false;
		executionRef.current = null;
		setPendingAction(null);
		setError(null);
		setExecution(null);
		setDocument(null);
		setConfirmation(null);
		if (!docId) return;
		let active = true;
		void reload(docId).catch((cause: unknown) => {
			if (!active || docIdRef.current !== docId) return;
			setError(toPanelError(cause, getErrorMessage(isApiError(cause) ? cause.code : null)));
		});
		return () => {
			active = false;
		};
	}, [docId, reload]);

	const loadAgents = useCallback(
		async (targetDocId: string) => {
			const seq = ++agentLoadSeq.current;
			const response = await client.listAgents();
			if (seq === agentLoadSeq.current && docIdRef.current === targetDocId) {
				setAgentEntries(response.agents);
			}
		},
		[client],
	);
	useEffect(() => {
		if (!docId) return;
		let active = true;
		void loadAgents(docId).catch((cause: unknown) => {
			if (!active || docIdRef.current !== docId) return;
			setError(toPanelError(cause, getErrorMessage(isApiError(cause) ? cause.code : null)));
		});
		return () => {
			active = false;
			agentLoadSeq.current += 1;
		};
	}, [docId, loadAgents]);

	useEffect(() => {
		const onSnapshot = (rows: readonly DocumentExecutionDto[]) => {
			const selected = docIdRef.current;
			if (!selected) return;
			const match = rows.find((row) => row.docId === selected);
			if (!match || !isExecutionDto(match)) return;
			eventSerial.current += 1;
			// 同一轮提交里，旧的 GET 会在这次 setState 刷新生效前读 ref。
			if (!shouldAdoptExecution(selected, executionRef.current, match)) return;
			executionRef.current = match;
			setExecution(match);
		};
		snapshotListeners.add(onSnapshot);
		const unsubscribe = eventBus.subscribeMilestone((event: EventEnvelope) => {
			if (
				event.kind !== 'document.execution_changed' &&
				event.kind !== 'system.docs_changed' &&
				event.kind !== 'document.settings_changed' &&
				event.kind !== 'agent.availability_changed' &&
				event.kind !== 'task.landed' &&
				event.kind !== 'batch.advanced'
			) {
				return;
			}
			invalidateForEvent(event.kind);
			const selected = docIdRef.current;
			if (!selected) return;
			if (event.kind === 'agent.availability_changed')
				void loadAgents(selected).catch(() => undefined);
			if (event.kind === 'document.execution_changed') {
				const incoming = readExecutionPayload(event.payload);
				if (!incoming) {
					void reload(selected).catch(() => undefined);
					return;
				}
				if (incoming.docId !== selected) return;
				eventSerial.current += 1;
				if (!shouldAdoptExecution(selected, executionRef.current, incoming)) return;
				executionRef.current = incoming;
				setExecution(incoming);
				return;
			}
			void reload(selected).catch(() => undefined);
		});
		const unregisterResync = registerResyncHandler(() => {
			const selected = docIdRef.current;
			if (!selected) return;
			invalidate(CACHE_KEYS.documentExecutions(selected));
			invalidate(CACHE_KEYS.documents());
			return reload(selected).then(() => undefined);
		});
		const unregisterReplay = sseClient.onClearBuffer(() => {
			const selected = docIdRef.current;
			if (!selected) return;
			void reload(selected).catch(() => undefined);
		});
		return () => {
			snapshotListeners.delete(onSnapshot);
			unsubscribe();
			unregisterResync();
			unregisterReplay();
		};
	}, [loadAgents, reload]);

	const updateDraft = useCallback(
		(patch: (current: DocumentDefaultAssignment) => DocumentDefaultAssignment) => {
			if (!docId || (execution && execution.state !== 'idle')) return;
			setDrafts((current) => {
				const base = current[docId] ?? execution?.defaultAssignment ?? EMPTY_ASSIGNMENT;
				return { ...current, [docId]: patch(base) };
			});
		},
		[docId, execution],
	);

	const setAgentId = useCallback(
		(agentId: string) => {
			updateDraft((current) =>
				current.agentId === agentId ? current : { agentId, modelName: null, effort: null },
			);
		},
		[updateDraft],
	);

	const setModelName = useCallback(
		(modelName: string | null) => {
			updateDraft((current) => ({ ...current, modelName: modelName || null }));
		},
		[updateDraft],
	);

	const setEffort = useCallback(
		(effort: EffortValue) => {
			updateDraft((current) => ({ ...current, effort }));
		},
		[updateDraft],
	);

	const fail = useCallback(
		(cause: unknown, observedDocId: string, seq: number) => {
			invalidate(CACHE_KEYS.documentExecutions(observedDocId));
			invalidate(CACHE_KEYS.documents());
			if (requestSeq.current !== seq || docIdRef.current !== observedDocId) return;
			if (isApiError(cause) && isVersionConflict(cause)) {
				const incoming = readExecutionPayload({ execution: cause.details?.execution });
				if (incoming) {
					eventSerial.current += 1;
					if (shouldAdoptExecution(observedDocId, executionRef.current, incoming)) {
						executionRef.current = incoming;
						setExecution(incoming);
					}
				}
				setError(toPanelError(cause, UI_STRINGS.documentExecution.versionConflict));
				invalidate(CACHE_KEYS.documentExecutions(observedDocId));
				void reload(observedDocId).catch(() => undefined);
				return;
			}
			const message =
				isApiError(cause) && cause.code === 'E_SNAPSHOT_STALE'
					? UI_STRINGS.documentExecution.snapshotStale
					: getErrorMessage(isApiError(cause) ? cause.code : null);
			setError(toPanelError(cause, message));
			invalidate(CACHE_KEYS.documentExecutions(observedDocId));
			void reload(observedDocId).catch(() => undefined);
		},
		[reload],
	);

	const runControl = useCallback(
		async (
			action: 'start' | 'pause' | 'resume',
			send: (targetDocId: string, body: never) => Promise<unknown>,
			body: StartDocumentExecutionBody | PauseDocumentExecutionBody | ResumeDocumentExecutionBody,
		) => {
			if (!docId || pendingRef.current || !canControl) return;
			const seq = ++requestSeq.current;
			const observedDocId = docId;
			const frozen = Object.freeze({ ...body });
			pendingRef.current = true;
			setPendingAction(action);
			setError(null);
			try {
				await send(observedDocId, frozen as never);
				invalidate(CACHE_KEYS.documentExecutions(observedDocId));
				if (requestSeq.current !== seq || docIdRef.current !== observedDocId) return;
				await reload(observedDocId);
			} catch (cause) {
				fail(cause, observedDocId, seq);
			} finally {
				if (requestSeq.current === seq) {
					pendingRef.current = false;
					setPendingAction(null);
				}
			}
		},
		[canControl, docId, fail, reload],
	);

	const start = useCallback(async () => {
		if (!document?.contentFingerprint || !assignment.agentId) return;
		const body: StartDocumentExecutionBody = Object.freeze({
			expectedVersion: execution?.version ?? 0,
			expectedFingerprint: document.contentFingerprint,
			defaultAssignment: Object.freeze({
				agentId: assignment.agentId,
				modelName: assignment.modelName,
				effort: assignment.effort,
			}),
		});
		await runControl('start', client.start, body);
	}, [assignment, client.start, document?.contentFingerprint, execution?.version, runControl]);

	const pause = useCallback(async () => {
		const body: PauseDocumentExecutionBody = Object.freeze({
			expectedVersion: execution?.version ?? 0,
		});
		await runControl('pause', client.pause, body);
	}, [client.pause, execution?.version, runControl]);

	const resume = useCallback(async () => {
		if (!document?.contentFingerprint) return;
		const body: ResumeDocumentExecutionBody = Object.freeze({
			expectedVersion: execution?.version ?? 0,
			expectedFingerprint: document.contentFingerprint,
		});
		await runControl('resume', client.resume, body);
	}, [client.resume, document?.contentFingerprint, execution?.version, runControl]);

	const confirmSource = useCallback(async () => {
		if (!docId || pendingRef.current || !canControl) return;
		const seq = ++requestSeq.current;
		const observedDocId = docId;
		pendingRef.current = true;
		setPendingAction('refresh');
		setError(null);
		try {
			await client.refreshDocument(observedDocId);
			invalidate(CACHE_KEYS.documents());
			invalidate(CACHE_KEYS.documentExecutions(observedDocId));
			if (requestSeq.current !== seq || docIdRef.current !== observedDocId) return;
			const loaded = await reload(observedDocId);
			if (requestSeq.current !== seq || docIdRef.current !== observedDocId || !loaded?.document)
				return;
			setConfirmation({
				docId: observedDocId,
				fingerprint: loaded.document.contentFingerprint,
				version: loaded.execution?.version ?? executionRef.current?.version ?? 0,
			});
		} catch (cause) {
			fail(cause, observedDocId, seq);
		} finally {
			if (requestSeq.current === seq) {
				pendingRef.current = false;
				setPendingAction(null);
			}
		}
	}, [canControl, client, docId, fail, reload]);

	const refreshAgent = useCallback(async () => {
		if (!assignment.agentId || pendingRef.current || !canControl) return;
		const seq = ++requestSeq.current;
		const observedDocId = docId;
		pendingRef.current = true;
		setPendingAction('probe');
		setError(null);
		try {
			await client.probeAgent(assignment.agentId);
			invalidate(CACHE_KEYS.agents());
			await catalogEntry?.refresh();
			if (observedDocId && requestSeq.current === seq && docIdRef.current === observedDocId) {
				invalidate('agents');
				const response = await client.listAgents();
				if (requestSeq.current === seq && docIdRef.current === observedDocId) {
					setAgentEntries(response.agents);
				}
				await reload(observedDocId);
			}
		} catch (cause) {
			if (observedDocId) fail(cause, observedDocId, seq);
		} finally {
			if (requestSeq.current === seq) {
				pendingRef.current = false;
				setPendingAction(null);
			}
		}
	}, [assignment.agentId, canControl, catalogEntry, client, docId, fail, reload]);

	const needsSourceConfirm = needsSourceConfirmation(currentExecution?.pauseReason);
	const sourceConfirmed =
		confirmation !== null &&
		confirmation.docId === docId &&
		confirmation.fingerprint === currentDocument?.contentFingerprint &&
		confirmation.version === currentExecution?.version;
	const idleControls = !pendingAction && canControl;
	const agents = useMemo(() => {
		const base = toAgents(agentEntries);
		if (!catalogEntry || !assignment.agentId) return base;
		return base.map((agent) =>
			agent.id === assignment.agentId
				? {
						...agent,
						catalog: catalogEntry.catalog,
						currentConfig: catalogEntry.currentConfig,
						isRefreshingModels: catalogEntry.isRefreshing,
					}
				: agent,
		);
	}, [agentEntries, assignment.agentId, catalogEntry]);

	return {
		execution: currentExecution,
		document: currentDocument,
		documents,
		agents,
		assignment,
		catalog: catalogEntry?.catalog ?? null,
		isRefreshingModels: catalogEntry?.isRefreshing ?? false,
		pendingAction,
		error,
		canControl,
		canStart:
			idleControls &&
			currentExecution?.canStart === true &&
			assignment.agentId.length > 0 &&
			Boolean(currentDocument?.contentFingerprint),
		canPause: idleControls && currentExecution?.canPause === true,
		canResume:
			idleControls &&
			currentExecution?.canResume === true &&
			Boolean(currentDocument?.contentFingerprint) &&
			(!needsSourceConfirm || sourceConfirmed),
		needsSourceConfirm,
		sourceConfirmed,
		setAgentId,
		setModelName,
		setEffort,
		start,
		pause,
		resume,
		confirmSource,
		refreshAgent,
	};
}
