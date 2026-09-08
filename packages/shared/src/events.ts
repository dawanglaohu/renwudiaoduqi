export type EventScope = 'run' | 'task' | 'batch' | 'agent' | 'system';

export const EVENT_SCOPES = [
	'run',
	'task',
	'batch',
	'agent',
	'system',
] as const satisfies readonly EventScope[];

/**
 * ACP group: session/update events strictly preserved in snake_case.
 */
export const ACP_EVENT_KINDS = [
	'agent_message_chunk',
	'agent_thought_chunk',
	'tool_call',
	'tool_call_update',
	'plan',
	'available_commands_update',
] as const;

/**
 * Product group: <scope>.<past_tense_verb>.
 */
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
	'task.gate_waiting',
	'task.gate_passed',
	'task.review_verdict',
	'task.landed',
	'batch.advanced',
	'agent.availability_changed',
	'system.disk_warning',
	'system.docs_changed',
] as const;

export const EVENT_KINDS = [...ACP_EVENT_KINDS, ...PRODUCT_EVENT_KINDS] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface TruncatedPayloadRef {
	readonly truncated: true;
	readonly byteLen: number;
	readonly ref?: {
		readonly fileSeq: number;
		readonly byteOffset: number;
		readonly byteLen: number;
	} | null;
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
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface BatchAdvancedPayload {
	readonly batchId: string;
	readonly stage?: string;
	readonly vendor?: unknown;
	readonly [key: string]: unknown;
}

export interface AgentAvailabilityChangedPayload {
	readonly agentId: string;
	readonly available: boolean;
	readonly reason?: string;
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

export interface TypedEventEnvelope<K extends EventKind, S extends EventScope, P> {
	readonly id: number;
	readonly ts: string;
	readonly runId: string | null;
	readonly taskId: string | null;
	readonly scope: S;
	readonly kind: K;
	readonly seq: number;
	readonly actorDeviceId: string | null;
	readonly payload: P | TruncatedPayloadRef;
}

export type AgentMessageChunkEnvelope = TypedEventEnvelope<
	'agent_message_chunk',
	'run',
	AgentMessageChunkPayload
>;
export type AgentThoughtChunkEnvelope = TypedEventEnvelope<
	'agent_thought_chunk',
	'run',
	AgentThoughtChunkPayload
>;
export type ToolCallEnvelope = TypedEventEnvelope<'tool_call', 'run', ToolCallPayload>;
export type ToolCallUpdateEnvelope = TypedEventEnvelope<
	'tool_call_update',
	'run',
	ToolCallUpdatePayload
>;
export type PlanEnvelope = TypedEventEnvelope<'plan', 'run', PlanPayload>;
export type AvailableCommandsUpdateEnvelope = TypedEventEnvelope<
	'available_commands_update',
	'run',
	AvailableCommandsUpdatePayload
>;

export type RunStateChangedEnvelope = TypedEventEnvelope<
	'run.state_changed',
	'run',
	RunStateChangedPayload
>;
export type RunStartedEnvelope = TypedEventEnvelope<'run.started', 'run', RunStartedPayload>;
export type RunExitedEnvelope = TypedEventEnvelope<'run.exited', 'run', RunExitedPayload>;
export type RunAbortedEnvelope = TypedEventEnvelope<'run.aborted', 'run', RunAbortedPayload>;
export type RunStalledSuspectedEnvelope = TypedEventEnvelope<
	'run.stalled_suspected',
	'run',
	RunStalledSuspectedPayload
>;
export type RunStderrLineEnvelope = TypedEventEnvelope<
	'run.stderr_line',
	'run',
	RunStderrLinePayload
>;
export type RunPermissionBlockedEnvelope = TypedEventEnvelope<
	'run.permission_blocked',
	'run',
	RunPermissionBlockedPayload
>;
export type RunRemotePushDetectedEnvelope = TypedEventEnvelope<
	'run.remote_push_detected',
	'run',
	RunRemotePushDetectedPayload
>;
export type RunMessageDeliveredEnvelope = TypedEventEnvelope<
	'run.message_delivered',
	'run',
	RunMessageDeliveredPayload
>;
export type RunMessageUndeliveredEnvelope = TypedEventEnvelope<
	'run.message_undelivered',
	'run',
	RunMessageUndeliveredPayload
>;

export type TaskGateWaitingEnvelope = TypedEventEnvelope<
	'task.gate_waiting',
	'task',
	TaskGateWaitingPayload
>;
export type TaskGatePassedEnvelope = TypedEventEnvelope<
	'task.gate_passed',
	'task',
	TaskGatePassedPayload
>;
export type TaskReviewVerdictEnvelope = TypedEventEnvelope<
	'task.review_verdict',
	'task',
	TaskReviewVerdictPayload
>;
export type TaskLandedEnvelope = TypedEventEnvelope<'task.landed', 'task', TaskLandedPayload>;

export type BatchAdvancedEnvelope = TypedEventEnvelope<
	'batch.advanced',
	'batch',
	BatchAdvancedPayload
>;

export type AgentAvailabilityChangedEnvelope = TypedEventEnvelope<
	'agent.availability_changed',
	'agent',
	AgentAvailabilityChangedPayload
>;

export type SystemDiskWarningEnvelope = TypedEventEnvelope<
	'system.disk_warning',
	'system',
	SystemDiskWarningPayload
>;
export type SystemDocsChangedEnvelope = TypedEventEnvelope<
	'system.docs_changed',
	'system',
	SystemDocsChangedPayload
>;

export type EventEnvelope =
	| AgentMessageChunkEnvelope
	| AgentThoughtChunkEnvelope
	| ToolCallEnvelope
	| ToolCallUpdateEnvelope
	| PlanEnvelope
	| AvailableCommandsUpdateEnvelope
	| RunStateChangedEnvelope
	| RunStartedEnvelope
	| RunExitedEnvelope
	| RunAbortedEnvelope
	| RunStalledSuspectedEnvelope
	| RunStderrLineEnvelope
	| RunPermissionBlockedEnvelope
	| RunRemotePushDetectedEnvelope
	| RunMessageDeliveredEnvelope
	| RunMessageUndeliveredEnvelope
	| TaskGateWaitingEnvelope
	| TaskGatePassedEnvelope
	| TaskReviewVerdictEnvelope
	| TaskLandedEnvelope
	| BatchAdvancedEnvelope
	| AgentAvailabilityChangedEnvelope
	| SystemDiskWarningEnvelope
	| SystemDocsChangedEnvelope;

export interface CanonicalEventEnvelope {
	readonly id: number;
	readonly ts: string;
	readonly runId: string | null;
	readonly taskId: string | null;
	readonly scope: EventScope;
	readonly kind: EventKind;
	readonly seq: number;
	readonly actorDeviceId: string | null;
	readonly payload: unknown;
}

export function scopeFromEventKind(kind: EventKind): EventScope {
	if (kind.startsWith('run.') || ACP_EVENT_KINDS.some((k) => k === kind)) {
		return 'run';
	}
	if (kind.startsWith('task.')) {
		return 'task';
	}
	if (kind.startsWith('batch.')) {
		return 'batch';
	}
	if (kind.startsWith('agent.')) {
		return 'agent';
	}
	if (kind.startsWith('system.')) {
		return 'system';
	}
	return 'run';
}

export function isEventKind(value: unknown): value is EventKind {
	return typeof value === 'string' && EVENT_KINDS.some((kind) => kind === value);
}

const MILESTONE_KIND_PREFIXES = ['run.', 'task.', 'batch.', 'system.', 'agent.'] as const;
const MILESTONE_KIND_EXACT = ['tool_call', 'tool_call_update', 'plan'] as const;

export function isMilestoneEventKind(kind: string): boolean {
	return (
		MILESTONE_KIND_EXACT.some((exact) => exact === kind) ||
		MILESTONE_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix))
	);
}

export function assertNever(value: never, message = 'Unhandled discriminated union member'): never {
	throw new Error(`${message}: ${JSON.stringify(value)}`);
}
