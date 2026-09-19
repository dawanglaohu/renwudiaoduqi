import type { LoginState } from './agents.ts';
import type { BatchState } from './batches.ts';
import type { GateSettings } from './settings.ts';

export type EventScope = 'run' | 'task' | 'batch' | 'agent' | 'system' | 'lane' | 'settings';

export const EVENT_SCOPES = [
	'run',
	'task',
	'batch',
	'agent',
	'system',
	'lane',
	'settings',
] as const satisfies readonly EventScope[];

/**
 * Single exhaustive mapping table deriving kinds, scopes, and milestone classifications.
 */
export const EVENT_DEFINITIONS = {
	// ACP group: strictly snake_case, session/update events
	agent_message_chunk: { scope: 'run', milestone: false },
	agent_thought_chunk: { scope: 'run', milestone: false },
	tool_call: { scope: 'run', milestone: true },
	tool_call_update: { scope: 'run', milestone: true },
	plan: { scope: 'run', milestone: true },
	available_commands_update: { scope: 'run', milestone: false },

	// Product group: <scope>.<past_tense_verb>
	'run.state_changed': { scope: 'run', milestone: true },
	'run.started': { scope: 'run', milestone: true },
	'run.exited': { scope: 'run', milestone: true },
	'run.aborted': { scope: 'run', milestone: true },
	'run.stalled_suspected': { scope: 'run', milestone: true },
	'run.stderr_line': { scope: 'run', milestone: true },
	'run.permission_blocked': { scope: 'run', milestone: true },
	'run.remote_push_detected': { scope: 'run', milestone: true },
	'run.message_delivered': { scope: 'run', milestone: true },
	'run.message_undelivered': { scope: 'run', milestone: true },
	'run.rework_dispatched': { scope: 'run', milestone: true },
	'task.gate_waiting': { scope: 'task', milestone: true },
	'task.gate_passed': { scope: 'task', milestone: true },
	'task.review_verdict': { scope: 'task', milestone: true },
	'task.landed': { scope: 'task', milestone: true },
	'task.sessions_archived': { scope: 'task', milestone: true },
	'lane.released': { scope: 'lane', milestone: true },
	'batch.advanced': { scope: 'batch', milestone: true },
	'batch.wrapup_started': { scope: 'batch', milestone: true },
	'batch.wrapup_finished': { scope: 'batch', milestone: true },
	'agent.availability_changed': { scope: 'agent', milestone: true },
	'settings.gates_changed': { scope: 'settings', milestone: true },
	'system.disk_warning': { scope: 'system', milestone: true },
	'system.docs_changed': { scope: 'system', milestone: true },
} as const;

export type EventKind = keyof typeof EVENT_DEFINITIONS;

/**
 * Normalized assistant-text event kind.
 *
 * Consumers outside adapter/domain layers use this semantic constant instead of
 * repeating the ACP wire spelling, so vendor protocol strings stay isolated.
 */
export const AGENT_MESSAGE_CHUNK_EVENT_KIND = 'agent_message_chunk' as const satisfies EventKind;

const EVENT_KIND_VALUES = [
	'agent_message_chunk',
	'agent_thought_chunk',
	'tool_call',
	'tool_call_update',
	'plan',
	'available_commands_update',
	'run.state_changed',
	'run.started',
	'run.exited',
	'run.aborted',
	'run.stalled_suspected',
	'run.stderr_line',
	'run.permission_blocked',
	'run.remote_push_detected',
	'run.message_delivered',
	'run.message_undelivered',
	'run.rework_dispatched',
	'task.gate_waiting',
	'task.gate_passed',
	'task.review_verdict',
	'task.landed',
	'task.sessions_archived',
	'lane.released',
	'batch.advanced',
	'batch.wrapup_started',
	'batch.wrapup_finished',
	'agent.availability_changed',
	'settings.gates_changed',
	'system.disk_warning',
	'system.docs_changed',
] as const satisfies readonly EventKind[];

type ExhaustiveEventKindList<Kinds extends readonly EventKind[]> = Exclude<
	EventKind,
	Kinds[number]
> extends never
	? Kinds
	: never;

export const EVENT_KINDS: ExhaustiveEventKindList<typeof EVENT_KIND_VALUES> = EVENT_KIND_VALUES;

export const ACP_EVENT_KINDS = [
	'agent_message_chunk',
	'agent_thought_chunk',
	'tool_call',
	'tool_call_update',
	'plan',
	'available_commands_update',
] as const satisfies readonly EventKind[];

export const PRODUCT_EVENT_KINDS = [
	'run.state_changed',
	'run.started',
	'run.exited',
	'run.aborted',
	'run.stalled_suspected',
	'run.stderr_line',
	'run.permission_blocked',
	'run.remote_push_detected',
	'run.message_delivered',
	'run.message_undelivered',
	'run.rework_dispatched',
	'task.gate_waiting',
	'task.gate_passed',
	'task.review_verdict',
	'task.landed',
	'task.sessions_archived',
	'lane.released',
	'batch.advanced',
	'batch.wrapup_started',
	'batch.wrapup_finished',
	'agent.availability_changed',
	'settings.gates_changed',
	'system.disk_warning',
	'system.docs_changed',
] as const satisfies readonly EventKind[];

export interface TruncatedPayloadRef {
	readonly truncated: true;
	readonly byteLen: number;
	readonly ref: {
		readonly fileSeq: number;
		readonly byteOffset: number;
		readonly byteLen: number;
	};
}

export interface AgentMessageChunkPayload {
	readonly chunk: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface AgentThoughtChunkPayload {
	readonly chunk: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface ToolCallPayload {
	readonly callId?: string;
	readonly tool?: string;
	readonly input?: unknown;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface ToolCallUpdatePayload {
	readonly callId?: string;
	readonly output?: unknown;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface PlanPayload {
	readonly entries?: readonly unknown[];
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface AvailableCommandsUpdatePayload {
	readonly commands?: readonly string[];
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunStateChangedPayload {
	readonly from: string;
	readonly to: string;
	readonly reason?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunStartedPayload {
	readonly runId?: string;
	readonly pid?: number;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunExitedPayload {
	readonly exitCode: number | null;
	readonly signal?: string | null;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunAbortedPayload {
	readonly reason?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunStalledSuspectedPayload {
	readonly durationMs?: number;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunStderrLinePayload {
	readonly line: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunPermissionBlockedPayload {
	readonly tool?: string;
	readonly reason?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunRemotePushDetectedPayload {
	readonly branch?: string;
	readonly commit?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunMessageDeliveredPayload {
	readonly messageId: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunMessageUndeliveredPayload {
	readonly messageId: string;
	readonly reason?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface RunReworkDispatchedPayload {
	readonly mode: 'inject' | 'resume' | 'new_run';
	readonly source: 'review' | 'human' | 'manual' | 'wrapup';
	readonly targetRunId?: string;
	readonly reviewRunId?: string | null;
	readonly reworkRunId?: string;
	readonly reworkCount?: number;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface TaskGateWaitingPayload {
	readonly gate: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface TaskGatePassedPayload {
	readonly gate: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface TaskReviewVerdictPayload {
	readonly verdict: string;
	readonly details?: unknown;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface TaskLandedPayload {
	readonly branch?: string;
	readonly prUrl?: string;
	readonly by?: 'auto' | 'human';
	readonly gateId?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface SettingsGatesChangedPayload {
	readonly gates: GateSettings;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface LaneReleasedPayload {
	readonly docId: string | null;
	readonly laneNo: number | null;
	readonly taskId: string;
	readonly runId: string;
	readonly reason: 'landed' | 'awaiting_human' | 'failed' | 'aborted' | 'interrupted';
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface TaskSessionsArchivedPayload {
	readonly taskId: string;
	readonly runIds: readonly string[];
	readonly killedPids: readonly number[];
	readonly residualPids: readonly number[];
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface BatchAdvancedPayload {
	readonly batchId: string;
	readonly from?: string;
	readonly to?: string;
	readonly reason?: string;
	readonly batchNo?: number;
	readonly stage?: string;
	readonly state?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface BatchWrapupStartedPayload {
	readonly batchId: string;
	readonly batchNo: number;
	readonly runId: string;
	readonly round: number;
	readonly trigger: 'auto' | 'manual';
	readonly promptSource: 'docs' | 'builtin';
	readonly branchName: string | null;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface BatchWrapupFinishedPayload {
	readonly batchId: string;
	readonly batchNo: number;
	readonly runId: string;
	readonly round: number;
	readonly wrapupId: string | null;
	readonly verdict: 'clean' | 'fixed' | 'open' | 'unparsed';
	readonly declaredVerdict: 'clean' | 'fixed' | 'open' | null;
	readonly fixRunIds: readonly string[];
	readonly unassignedCount: number;
	readonly batchState: BatchState;
	readonly isHumanVerdict?: boolean;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface AgentAvailabilityChangedPayload {
	readonly agentId: string;
	readonly available: boolean;
	readonly reason?: string;
	readonly login?: LoginState | null;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface SystemDiskWarningPayload {
	readonly freeBytes?: number;
	readonly path?: string;
	readonly message?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface SystemDocsChangedPayload {
	readonly path?: string;
	readonly docsPath?: string;
	readonly fingerprint?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface EventPayloadMap {
	readonly agent_message_chunk: AgentMessageChunkPayload;
	readonly agent_thought_chunk: AgentThoughtChunkPayload;
	readonly tool_call: ToolCallPayload;
	readonly tool_call_update: ToolCallUpdatePayload;
	readonly plan: PlanPayload;
	readonly available_commands_update: AvailableCommandsUpdatePayload;
	readonly 'run.state_changed': RunStateChangedPayload;
	readonly 'run.started': RunStartedPayload;
	readonly 'run.exited': RunExitedPayload;
	readonly 'run.aborted': RunAbortedPayload;
	readonly 'run.stalled_suspected': RunStalledSuspectedPayload;
	readonly 'run.stderr_line': RunStderrLinePayload;
	readonly 'run.permission_blocked': RunPermissionBlockedPayload;
	readonly 'run.remote_push_detected': RunRemotePushDetectedPayload;
	readonly 'run.message_delivered': RunMessageDeliveredPayload;
	readonly 'run.message_undelivered': RunMessageUndeliveredPayload;
	readonly 'run.rework_dispatched': RunReworkDispatchedPayload;
	readonly 'task.gate_waiting': TaskGateWaitingPayload;
	readonly 'task.gate_passed': TaskGatePassedPayload;
	readonly 'task.review_verdict': TaskReviewVerdictPayload;
	readonly 'task.landed': TaskLandedPayload;
	readonly 'task.sessions_archived': TaskSessionsArchivedPayload;
	readonly 'lane.released': LaneReleasedPayload;
	readonly 'batch.advanced': BatchAdvancedPayload;
	readonly 'batch.wrapup_started': BatchWrapupStartedPayload;
	readonly 'batch.wrapup_finished': BatchWrapupFinishedPayload;
	readonly 'agent.availability_changed': AgentAvailabilityChangedPayload;
	readonly 'settings.gates_changed': SettingsGatesChangedPayload;
	readonly 'system.disk_warning': SystemDiskWarningPayload;
	readonly 'system.docs_changed': SystemDocsChangedPayload;
}

export interface TypedEventEnvelope<K extends EventKind = EventKind> {
	readonly id: number;
	readonly ts: string;
	readonly runId: string | null;
	readonly taskId: string | null;
	readonly scope: (typeof EVENT_DEFINITIONS)[K]['scope'];
	readonly kind: K;
	readonly seq: number;
	readonly actorDeviceId: string | null;
	readonly payload: EventPayloadMap[K] | TruncatedPayloadRef;
}

export type EventEnvelope = {
	[K in EventKind]: TypedEventEnvelope<K>;
}[EventKind];

export function scopeFromEventKind(kind: EventKind): EventScope {
	return EVENT_DEFINITIONS[kind].scope;
}

export function isEventKind(value: unknown): value is EventKind {
	return typeof value === 'string' && Object.hasOwn(EVENT_DEFINITIONS, value);
}

export function isMilestoneEventKind(kind: string): boolean {
	return isEventKind(kind) && EVENT_DEFINITIONS[kind].milestone;
}

export function assertNever(value: never, message = 'Unhandled discriminated union member'): never {
	throw new Error(`${message}: ${JSON.stringify(value)}`);
}
