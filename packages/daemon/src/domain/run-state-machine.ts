import { AppError } from '../errors/app-error.ts';

/**
 * 运行状态机的 13 个合法状态（09 节数据模型与 migrations/0001_init.sql）。
 */
export const RUN_STATES = [
	'queued',
	'starting',
	'running',
	'awaiting_reply',
	'exited',
	'reviewing',
	'reworking',
	'awaiting_human',
	'orphaned',
	'landed',
	'failed',
	'aborted',
	'interrupted',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * 四个终态：零出边、不可逆（09 节非法迁移表）。
 * landed / failed / aborted / interrupted。
 */
export const TERMINAL_RUN_STATES = ['landed', 'failed', 'aborted', 'interrupted'] as const;

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

/**
 * 不占并发额度的状态集合（09 节数据模型）。
 * awaiting_human 与 orphaned 不计入「每 agent 并发上限」（E-54）；
 * 四个终态进程已结束，同样不占并发额度；
 * awaiting_reply 仍然占用（E-115）。
 */
export const EXCLUDED_FROM_CONCURRENCY_STATES = [
	'awaiting_human',
	'orphaned',
	...TERMINAL_RUN_STATES,
] as const;

export type ExcludedFromConcurrencyState = (typeof EXCLUDED_FROM_CONCURRENCY_STATES)[number];

/**
 * 状态机迁移白名单（09 节状态机图与非法迁移表）。
 * 迁移表是白名单，不是黑名单。只对图上画出的边返回 true。
 */
export const VALID_RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze(
	{
		queued: Object.freeze(['starting', 'failed'] as const),
		starting: Object.freeze(['running', 'failed', 'interrupted', 'orphaned'] as const),
		running: Object.freeze([
			'awaiting_reply',
			'exited',
			'aborted',
			'orphaned',
			'interrupted',
		] as const),
		awaiting_reply: Object.freeze([
			'running',
			'exited',
			'aborted',
			'orphaned',
			'interrupted',
		] as const),
		exited: Object.freeze(['reviewing'] as const),
		reviewing: Object.freeze(['awaiting_human', 'reworking', 'landed'] as const),
		reworking: Object.freeze(['running', 'awaiting_human'] as const),
		awaiting_human: Object.freeze(['landed', 'reworking', 'failed'] as const),
		orphaned: Object.freeze(['aborted'] as const),
		landed: Object.freeze([] as const),
		failed: Object.freeze([] as const),
		aborted: Object.freeze([] as const),
		interrupted: Object.freeze([] as const),
	},
);

/**
 * 常见迁移原因枚举（常量），便于各模块引用（也可自定义原因字符串）。
 */
export const RUN_TRANSITION_REASONS = {
	// E-123
	DAEMON_RESTART_PROCESS_NOT_FOUND: 'daemon_restart_process_not_found',
	// E-02
	DAEMON_RESTART_UNRECONNECTABLE: 'daemon_restart_unreconnectable',
	// E-23
	PROCESS_EXITED: 'process_exited',
	REVIEW_PASSED_AUTO: 'review_passed_auto',
	HUMAN_CONFIRMED: 'human_confirmed',
	// E-118
	MANUAL_ABORT: 'manual_abort',
	// E-55
	REWORK_LIMIT_REACHED: 'rework_limit_reached',
	// E-59
	REWORK_INJECTION: 'rework_injection',
	HUMAN_REWORK: 'human_rework',
	// E-115
	AGENT_QUESTION: 'agent_question',
	// E-112
	HUMAN_REPLIED: 'human_replied',
	// E-76
	WORKSPACE_FAILED: 'workspace_failed',
	// E-190
	STARTUP_TIMEOUT: 'startup_timeout',
	// E-88
	EXEC_INVALID: 'exec_invalid',
	// E-61
	MECHANICAL_CHECK_FAILED: 'mechanical_check_failed',
	// E-66
	MECHANICAL_CHECK_TIMEOUT: 'mechanical_check_timeout',
	// E-62
	REVIEW_INCOMPLETE: 'review_incomplete',
	// E-64
	DOC_ISSUE: 'doc_issue',
	// E-53
	PASS_HUMAN_GATE: 'pass_human_gate',
	// E-113
	INJECTION_FAILED: 'injection_failed',
	// human rejection
	HUMAN_REJECTED: 'human_rejected',
	// human kill orphaned
	HUMAN_KILLED: 'human_killed',
} as const;

export type RunTransitionReason =
	(typeof RUN_TRANSITION_REASONS)[keyof typeof RUN_TRANSITION_REASONS];

/**
 * 迁移上下文参数，用于约束如自动重试上限（E-55）等条件。
 */
export interface RunTransitionContext {
	/**
	 * 当前已重试次数（rework_count）。
	 * 若在 reviewing 状态判定 rework 且 rework_count >= maxReworkCount（默认 2），
	 * 则禁止迁移至 reworking，必须转入 awaiting_human（E-55）。
	 */
	readonly reworkCount?: number;
	/**
	 * 允许的最大重试次数，默认 2。
	 */
	readonly maxReworkCount?: number;
}

/**
 * 校验输入是否为已知的运行状态。
 */
export function isValidRunState(state: unknown): state is RunState {
	return typeof state === 'string' && (RUN_STATES as readonly string[]).includes(state);
}

/**
 * 判断状态是否为终态（landed / failed / aborted / interrupted，E-123）。
 */
export function isTerminalRunState(state: RunState): state is TerminalRunState {
	return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/**
 * 判断状态是否占用每 agent 的并发配额。
 * awaiting_human 与 orphaned 不计入；终态不计入；awaiting_reply 仍占用（E-54, E-115）。
 */
export function countsTowardAgentConcurrency(state: RunState): boolean {
	return !(EXCLUDED_FROM_CONCURRENCY_STATES as readonly RunState[]).includes(state);
}

/**
 * 判断是否可直接进入 landed 状态（E-23）。
 * 落地只能由自动审查（reviewing）判定通过或人工确认（awaiting_human）进入，
 * 绝不存在 exited → landed。
 */
export function canTransitionToLanded(from: RunState): boolean {
	return from === 'reviewing' || from === 'awaiting_human';
}

/**
 * 判定给定状态在 daemon 重启时是否需要进行进程 PID 对账（E-123 / E-02）。
 * 处于 starting / running / awaiting_reply 的记录在重启后必须核对 PID。
 */
export function isReconciliationCandidate(state: RunState): boolean {
	return state === 'starting' || state === 'running' || state === 'awaiting_reply';
}

/**
 * 状态机迁移纯函数：按白名单判定是否允许从 from 迁移到 to。
 * 白名单之外一律返回 false。
 * 特别地：
 * 1. exited → landed 恒为 false（E-23）
 * 2. interrupted 出边恒为 false（E-123）
 * 3. reviewing → reworking 在 reworkCount >= maxReworkCount 时为 false（E-55）
 */
export function canTransition(
	from: RunState,
	to: RunState,
	context?: RunTransitionContext,
): boolean {
	if (!isValidRunState(from) || !isValidRunState(to)) {
		return false;
	}

	const allowedTargets = VALID_RUN_TRANSITIONS[from];
	if (!allowedTargets.includes(to)) {
		return false;
	}

	// E-55: 审查判定 rework 时，若已达自动重试上限（默认 2），禁止再进入 reworking
	if (from === 'reviewing' && to === 'reworking' && context?.reworkCount !== undefined) {
		const max = context.maxReworkCount ?? 2;
		if (context.reworkCount >= max) {
			return false;
		}
	}

	return true;
}

/**
 * 断言迁移是否合法；非法迁移抛出带 E_INVALID_STATE_TRANSITION 错误码的 AppError。
 */
export function assertValidTransition(
	from: RunState,
	to: RunState,
	context?: RunTransitionContext & { readonly reason?: string },
): void {
	if (!canTransition(from, to, context)) {
		const reasonSuffix = context?.reason ? ` (attempted reason: '${context.reason}')` : '';
		throw new AppError(
			'E_INVALID_STATE_TRANSITION',
			`Invalid run state transition from '${from}' to '${to}'${reasonSuffix}.`,
			{
				details: {
					from,
					to,
					reason: context?.reason,
					reworkCount: context?.reworkCount,
					maxReworkCount: context?.maxReworkCount ?? 2,
					allowedTargets: VALID_RUN_TRANSITIONS[from] ?? [],
				},
			},
		);
	}
}

/**
 * 依赖注入契约：时钟与 ID 分配器。
 */
export interface RunStateMachineClock {
	readonly now: () => string;
}

export interface RunStateMachineIds {
	readonly newId: () => string;
}

export interface RunStateMachineDeps {
	readonly clock: RunStateMachineClock;
	readonly ids: RunStateMachineIds;
}

export interface RunStateTransitionInput {
	readonly runId: string;
	readonly from: RunState;
	readonly to: RunState;
	readonly reason: string;
	readonly actorDeviceId?: string | null;
	readonly taskId?: string | null;
	readonly reworkCount?: number;
	readonly maxReworkCount?: number;
}

export interface RunStateChangedEventPayload {
	readonly from: RunState;
	readonly to: RunState;
	readonly reason: string;
}

export interface RunStateChangedEvent {
	readonly id: string;
	readonly ts: string;
	readonly runId: string;
	readonly taskId: string | null;
	readonly scope: 'run';
	readonly kind: 'run.state_changed';
	readonly actorDeviceId: string | null;
	readonly payload: RunStateChangedEventPayload;
}

export interface RunStateTransitionResult {
	readonly transitionId: string;
	readonly runId: string;
	readonly from: RunState;
	readonly to: RunState;
	readonly reason: string;
	readonly occurredAt: string;
	readonly event: RunStateChangedEvent;
	readonly isTerminal: boolean;
	readonly countsTowardConcurrency: boolean;
}

/**
 * 运行状态机工厂（通过 DI 注入时钟与 id）。
 */
export function createRunStateMachine(deps: RunStateMachineDeps) {
	return {
		canTransition(from: RunState, to: RunState, context?: RunTransitionContext): boolean {
			return canTransition(from, to, context);
		},

		assertValidTransition(
			from: RunState,
			to: RunState,
			context?: RunTransitionContext & { readonly reason?: string },
		): void {
			assertValidTransition(from, to, context);
		},

		transition(input: RunStateTransitionInput): RunStateTransitionResult {
			assertValidTransition(input.from, input.to, {
				reworkCount: input.reworkCount,
				maxReworkCount: input.maxReworkCount,
				reason: input.reason,
			});

			const transitionId = deps.ids.newId();
			const occurredAt = deps.clock.now();
			const eventPayload: RunStateChangedEventPayload = {
				from: input.from,
				to: input.to,
				reason: input.reason,
			};

			const event: RunStateChangedEvent = {
				id: transitionId,
				ts: occurredAt,
				runId: input.runId,
				taskId: input.taskId ?? null,
				scope: 'run',
				kind: 'run.state_changed',
				actorDeviceId: input.actorDeviceId ?? null,
				payload: eventPayload,
			};

			return {
				transitionId,
				runId: input.runId,
				from: input.from,
				to: input.to,
				reason: input.reason,
				occurredAt,
				event,
				isTerminal: isTerminalRunState(input.to),
				countsTowardConcurrency: countsTowardAgentConcurrency(input.to),
			};
		},
	};
}

export type RunStateMachine = ReturnType<typeof createRunStateMachine>;
