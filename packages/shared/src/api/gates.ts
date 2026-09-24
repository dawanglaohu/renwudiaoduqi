import type { LoginState } from './agents.ts';

export interface GateContextStderrTailLines {
	readonly kind: 'lines';
	readonly lines: readonly string[];
}

export interface GateContextStderrTailUnavailable {
	readonly kind: 'unavailable';
	readonly reason: 'legacy_run' | 'event_missing';
	readonly lines?: readonly [];
}

export type GateContextStderrTail = GateContextStderrTailLines | GateContextStderrTailUnavailable;

export interface GateContext {
	readonly exitCode: number | null;
	readonly exitSignal: string | null;
	readonly stderrTail: GateContextStderrTail;
	readonly login: LoginState | null;
}

export interface GateDto {
	readonly id: string;
	readonly taskId: string | null;
	readonly runId: string | null;
	readonly kind: 'dispatch' | 'review' | 'landing';
	readonly state: 'waiting' | 'decided';
	readonly decision: 'pass' | 'rework' | 'reject' | null;
	readonly comment: string | null;
	readonly decidedByDeviceId: string | null;
	readonly createdAt: string;
	readonly decidedAt: string | null;
	readonly context?: GateContext | null;
}

export interface ListGatesResponse {
	readonly gates: readonly GateDto[];
}

export interface DecideGateBody {
	readonly decision: 'pass' | 'reject';
	readonly comment?: string;
}

export const DECIDE_GATE_BODY_KEYS = [
	'comment',
	'decision',
] as const satisfies readonly (keyof DecideGateBody)[];

type AssertDecideGateBodyExhaustive = [
	Exclude<keyof DecideGateBody, (typeof DECIDE_GATE_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertDecideGateBody: AssertDecideGateBodyExhaustive = true;

export const decideGateBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['decision'],
	properties: {
		decision: { type: 'string', enum: ['pass', 'reject'] },
		comment: { type: 'string', maxLength: 2048 },
	},
} as const;

export interface DecideGateResponse {
	readonly applied: true;
}
