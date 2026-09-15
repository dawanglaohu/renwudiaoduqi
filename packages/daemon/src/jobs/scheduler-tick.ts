import type { DispatchService, SchedulerTickResult } from '../service/dispatch.ts';

export interface SchedulerTickJobDeps {
	readonly dispatchService: DispatchService;
	readonly intervalMs?: number;
	readonly logFailure?: (error: unknown) => void;
}

export interface SchedulerTickJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
	/**
	 * Executes one tick pass with mutual exclusion (AC 1).
	 * If a tick is currently running, skips execution and returns null.
	 */
	tick(): Promise<SchedulerTickResult | null>;
	runOnce(): Promise<SchedulerTickResult | null>;
	/**
	 * Triggers an immediate tick pass on external events (e.g. settings change or gate pass).
	 */
	trigger(): void;
}

const DEFAULT_SCHEDULER_TICK_INTERVAL_MS = 5000;

/**
 * scheduler-tick (08 节 后台工作 / M8-T3):
 * 事件触发 + 5s 兜底。
 * 全局一把内存互斥量，禁止并发 tick、禁止重入，同一任务不会被派两次（AC 1）。
 * 每个 tick 自己保证不重入（上一次未完成则跳过本次），内部 try/catch 把异常转成日志/事件，
 * 绝不让异常冒泡到 unhandledRejection。
 */
export function createSchedulerTickJob(deps: SchedulerTickJobDeps): SchedulerTickJob {
	const { dispatchService, intervalMs = DEFAULT_SCHEDULER_TICK_INTERVAL_MS, logFailure } = deps;

	let timer: NodeJS.Timeout | null = null;
	let inFlight: Promise<SchedulerTickResult | null> | null = null;
	let stopRequested = false;

	async function runOnceInternal(): Promise<SchedulerTickResult | null> {
		try {
			return await dispatchService.tick();
		} catch (error) {
			logFailure?.(error);
			return null;
		}
	}

	function runGuarded(): Promise<SchedulerTickResult | null> {
		// AC 1: 全局一把内存互斥量，禁止并发 tick、禁止重入
		if (inFlight !== null) {
			return Promise.resolve(null);
		}

		const pass = runOnceInternal().finally(() => {
			if (inFlight === pass) {
				inFlight = null;
			}
		});

		inFlight = pass;
		return pass;
	}

	function onInterval(): void {
		if (stopRequested) return;
		void runGuarded();
	}

	return Object.freeze({
		name: 'scheduler-tick',

		start(): void {
			stopRequested = false;
			if (timer !== null) return;
			// 启动时先执行一次 tick
			void runGuarded();
			timer = setInterval(onInterval, intervalMs);
			timer.unref();
		},

		async stop(): Promise<void> {
			stopRequested = true;
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// runOnceInternal catches errors; stop never throws
				}
			}
		},

		tick(): Promise<SchedulerTickResult | null> {
			return runGuarded();
		},

		runOnce(): Promise<SchedulerTickResult | null> {
			return runGuarded();
		},

		trigger(): void {
			if (stopRequested) return;
			void runGuarded();
		},
	});
}
