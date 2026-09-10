export const DEFAULT_STARTUP_TIMEOUT_MS_NATIVE = 60_000;
export const DEFAULT_STARTUP_TIMEOUT_MS_ACP = 180_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 900_000; // 900 seconds (15 minutes)
export const DEFAULT_HARD_WALL_CLOCK_MS = 0; // Disabled by default
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000; // 10 minutes (E-66)

export interface LaunchTimeouts {
	readonly startupTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly thinkingTimeoutMs?: number;
	readonly hardWallClockMs?: number;
	readonly checkTimeoutMs?: number;
}

/** Matches the container clock, which only exposes now(); nowMs is derived from it when absent. */
export interface Clock {
	now(): string;
	nowMs?(): number;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ProcessTimerDependencies {
	readonly clock?: Clock;
	readonly setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
	readonly clearTimeoutFn?: (timerId: TimerHandle) => void;
}

export interface ProcessTimerOptions extends ProcessTimerDependencies {
	readonly timeouts?: LaunchTimeouts;
	readonly isAcp?: boolean;
	readonly onStartupTimeout?: () => void;
	readonly onHardWallClockTimeout?: () => void;
	readonly onCheckTimeout?: () => void;
}

/**
 * Three-tier process timers controller (M1-T8, E-120, E-190).
 *
 * Timer tiers:
 * 1. startupTimeoutMs (native: 60s, generic-acp: 180s):
 *    Counts from spawn until initial parsable JSON event. On timeout: kills process tree
 *    with E_AGENT_STARTUP_TIMEOUT.
 * 2. idleTimeoutMs / thinkingTimeoutMs (default: 900s):
 *    Separated from startup timeout (E-190). Measures stream inactivity since last output.
 *    Used exclusively by stall-detector to emit weak warnings (run.stalled_suspected);
 *    PROC LAYER NEVER KILLS ON IDLE TIMEOUT (E-120).
 * 3. hardWallClockMs (default: 0 / disabled):
 *    Optional absolute maximum process runtime.
 *
 * Check timer:
 * - checkTimeoutMs (default: 600s / 10m, E-66):
 *    Only armed for mechanical check commands.
 */
export interface ProcessTimerController {
	readonly startupTimeoutMs: number;
	readonly idleTimeoutMs: number;
	readonly thinkingTimeoutMs: number;
	readonly hardWallClockMs: number;
	readonly checkTimeoutMs: number;
	readonly lastActivityAt: string;
	readonly isStartupTimerArmed: boolean;
	readonly isStartupCompleted: boolean;
	armStartupTimer(onTimeout?: () => void): void;
	disarmStartupTimer(): void;
	recordActivity(): void;
	armHardWallClockTimer(onTimeout?: () => void): void;
	armCheckTimer(onTimeout?: () => void): void;
	isIdleSuspected(nowMs?: number): boolean;
	idleDurationMs(nowMs?: number): number;
	clearAll(): void;
}

const DEFAULT_CLOCK: Clock = Object.freeze({
	now: () => new Date().toISOString(),
	nowMs: () => Date.now(),
});

export function createProcessTimers(options: ProcessTimerOptions = {}): ProcessTimerController {
	const clock = options.clock ?? DEFAULT_CLOCK;
	const readNowMs = (): number =>
		clock.nowMs !== undefined ? clock.nowMs() : Date.parse(clock.now());
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

	const startupTimeoutMs =
		options.timeouts?.startupTimeoutMs ??
		(options.isAcp ? DEFAULT_STARTUP_TIMEOUT_MS_ACP : DEFAULT_STARTUP_TIMEOUT_MS_NATIVE);
	const idleTimeoutMs =
		options.timeouts?.thinkingTimeoutMs ??
		options.timeouts?.idleTimeoutMs ??
		DEFAULT_IDLE_TIMEOUT_MS;
	const hardWallClockMs = options.timeouts?.hardWallClockMs ?? DEFAULT_HARD_WALL_CLOCK_MS;
	const checkTimeoutMs = options.timeouts?.checkTimeoutMs ?? 0;

	let lastActivityAt = clock.now();
	let lastActivityMs = readNowMs();

	let startupTimerId: TimerHandle | undefined = undefined;
	let hardTimerId: TimerHandle | undefined = undefined;
	let checkTimerId: TimerHandle | undefined = undefined;
	let startupArmed = false;
	let startupCompleted = false;

	function clearStartup(): void {
		if (startupTimerId !== undefined) {
			clearTimeoutFn(startupTimerId);
			startupTimerId = undefined;
		}
		startupArmed = false;
	}

	function clearHard(): void {
		if (hardTimerId !== undefined) {
			clearTimeoutFn(hardTimerId);
			hardTimerId = undefined;
		}
	}

	function clearCheck(): void {
		if (checkTimerId !== undefined) {
			clearTimeoutFn(checkTimerId);
			checkTimerId = undefined;
		}
	}

	function armStartupTimer(onTimeout?: () => void): void {
		clearStartup();
		startupCompleted = false;
		const handler = onTimeout ?? options.onStartupTimeout;
		if (startupTimeoutMs > 0 && handler !== undefined) {
			startupArmed = true;
			startupTimerId = setTimeoutFn(() => {
				startupArmed = false;
				startupTimerId = undefined;
				handler();
			}, startupTimeoutMs);
		}
	}

	function disarmStartupTimer(): void {
		clearStartup();
		startupCompleted = true;
		recordActivity();
	}

	function recordActivity(): void {
		lastActivityAt = clock.now();
		lastActivityMs = readNowMs();
	}

	function armHardWallClockTimer(onTimeout?: () => void): void {
		clearHard();
		const handler = onTimeout ?? options.onHardWallClockTimeout;
		if (hardWallClockMs > 0 && handler !== undefined) {
			hardTimerId = setTimeoutFn(() => {
				hardTimerId = undefined;
				handler();
			}, hardWallClockMs);
		}
	}

	function armCheckTimer(onTimeout?: () => void): void {
		clearCheck();
		const handler = onTimeout ?? options.onCheckTimeout;
		if (checkTimeoutMs > 0 && handler !== undefined) {
			checkTimerId = setTimeoutFn(() => {
				checkTimerId = undefined;
				handler();
			}, checkTimeoutMs);
		}
	}

	function isIdleSuspected(nowMs?: number): boolean {
		// E-190: Startup timeout and thinking/idle timeout are timed separately.
		// While cold startup is armed and not yet completed, the agent is starting up,
		// not idling or thinking; cold startup must not be misjudged as stalled.
		if (startupArmed && !startupCompleted) {
			return false;
		}
		const current = nowMs ?? readNowMs();
		return idleTimeoutMs > 0 && current - lastActivityMs >= idleTimeoutMs;
	}

	function idleDurationMs(nowMs?: number): number {
		if (startupArmed && !startupCompleted) {
			return 0;
		}
		const current = nowMs ?? readNowMs();
		return Math.max(0, current - lastActivityMs);
	}

	function clearAll(): void {
		clearStartup();
		clearHard();
		clearCheck();
	}

	return {
		startupTimeoutMs,
		idleTimeoutMs,
		thinkingTimeoutMs: idleTimeoutMs,
		hardWallClockMs,
		checkTimeoutMs,
		get lastActivityAt() {
			return lastActivityAt;
		},
		get isStartupTimerArmed() {
			return startupArmed;
		},
		get isStartupCompleted() {
			return startupCompleted;
		},
		armStartupTimer,
		disarmStartupTimer,
		recordActivity,
		armHardWallClockTimer,
		armCheckTimer,
		isIdleSuspected,
		idleDurationMs,
		clearAll,
	};
}
