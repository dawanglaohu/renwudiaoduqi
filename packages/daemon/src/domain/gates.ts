import type { GateDto } from '@agent-scheduler/shared/api/gates';
import type { GateSettings } from '@agent-scheduler/shared/api/settings';

export type GateKind = 'dispatch' | 'review' | 'landing';
export type GateState = 'waiting' | 'decided';
export type GateDecision = 'pass' | 'rework' | 'reject';
export type GateSettingMode = 'auto' | 'manual';

export type { GateSettings };

export interface GateOverrides {
	readonly dispatch?: GateSettingMode;
	readonly review?: GateSettingMode;
	readonly landing?: GateSettingMode;
}

export interface Gate {
	readonly id: string;
	readonly taskId: string | null;
	readonly runId: string | null;
	readonly kind: GateKind;
	readonly state: GateState;
	readonly decision: GateDecision | null;
	readonly comment: string | null;
	readonly decidedByDeviceId: string | null;
	readonly createdAt: string;
	readonly decidedAt: string | null;
}

export const DEFAULT_GATE_SETTINGS: GateSettings = Object.freeze({
	dispatch: 'auto',
	review: 'manual',
	landing: 'manual',
});

export const PRESET_SEMI_AUTO: GateSettings = Object.freeze({
	dispatch: 'auto',
	review: 'manual',
	landing: 'manual',
});

export const PRESET_AUTO: GateSettings = Object.freeze({
	dispatch: 'auto',
	review: 'auto',
	landing: 'auto',
});

export interface ResolveAfterReviewInput {
	readonly reviewVerdict: 'pass' | 'rework' | 'doc_issue' | 'incomplete' | string;
	readonly settings: GateSettings;
	readonly overrides?: GateOverrides | null;
}

export type ResolveAfterReviewResult =
	| {
			readonly outcome: 'landed';
			readonly by: 'auto';
			readonly gateKind: 'landing';
	  }
	| {
			readonly outcome: 'await_human';
			readonly gateKind: 'landing';
			readonly reason: string;
	  }
	| {
			readonly outcome: 'await_human';
			readonly gateKind: 'review';
			readonly reason: string;
	  };

/**
 * Resolves post-review gate progression according to M8-T4 rules:
 * - If review verdict is not 'pass', halts unconditionally for human review.
 * - If review verdict is 'pass', checks effective review gate (overrides take precedence over settings).
 * - If effective review gate is 'manual', stops at review gate for human confirmation.
 * - If effective review gate is 'auto', proceeds to check effective landing gate.
 * - If effective landing gate is 'auto', automatically transitions to 'landed' without human intervention
 *   (AC 1: strictly marks status landed, zero git operations).
 * - If effective landing gate is 'manual', stops at landing gate awaiting human confirmation (E-53).
 */
export function resolveAfterReview(input: ResolveAfterReviewInput): ResolveAfterReviewResult {
	if (input.reviewVerdict !== 'pass') {
		return {
			outcome: 'await_human',
			gateKind: 'review',
			reason: `review_verdict_${input.reviewVerdict}`,
		};
	}

	const effectiveReview = input.overrides?.review ?? input.settings.review;
	if (effectiveReview === 'manual') {
		return {
			outcome: 'await_human',
			gateKind: 'review',
			reason: 'review_manual_gate',
		};
	}

	const effectiveLanding = input.overrides?.landing ?? input.settings.landing;
	if (effectiveLanding === 'auto') {
		return {
			outcome: 'landed',
			by: 'auto',
			gateKind: 'landing',
		};
	}

	return {
		outcome: 'await_human',
		gateKind: 'landing',
		reason: 'landing_manual_gate',
	};
}

export function resolveEffectiveGateSettings(
	settings: GateSettings,
	overrides?: GateOverrides | null,
): GateSettings {
	if (!overrides) {
		return settings;
	}
	return Object.freeze({
		dispatch: overrides.dispatch ?? settings.dispatch,
		review: overrides.review ?? settings.review,
		landing: overrides.landing ?? settings.landing,
	});
}

export function isValidGateSettings(val: unknown): val is GateSettings {
	if (!val || typeof val !== 'object') return false;
	const candidate = val as Record<string, unknown>;
	const validModes = new Set(['auto', 'manual']);
	return (
		validModes.has(candidate.dispatch as string) &&
		validModes.has(candidate.review as string) &&
		validModes.has(candidate.landing as string)
	);
}

export function isGateKind(val: unknown): val is GateKind {
	return val === 'dispatch' || val === 'review' || val === 'landing';
}

export function isGateState(val: unknown): val is GateState {
	return val === 'waiting' || val === 'decided';
}

export function isGateDecision(val: unknown): val is GateDecision {
	return val === 'pass' || val === 'rework' || val === 'reject';
}

export function toGateDto(gate: Gate): GateDto {
	return Object.freeze({
		id: gate.id,
		taskId: gate.taskId,
		runId: gate.runId,
		kind: gate.kind,
		state: gate.state,
		decision: gate.decision,
		comment: gate.comment,
		decidedByDeviceId: gate.decidedByDeviceId,
		createdAt: gate.createdAt,
		decidedAt: gate.decidedAt,
	});
}
