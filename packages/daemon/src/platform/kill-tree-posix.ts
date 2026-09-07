import type {
	KillTreeAttempt,
	KillTreeAttemptMethod,
	KillTreeAttemptResult,
	KillTreeClock,
	KillTreeEmit,
	KillTreeResult,
} from './kill-tree-contract.ts';
import { KILL_TREE_GRACE_MS } from './kill-tree-contract.ts';

/**
 * Managed children are always spawned detached, so each occupies its own
 * process group. Signals go to the whole group via kill(-pid): SIGTERM first,
 * SIGKILL only after the grace window (E-119). process.kill doubles as the
 * liveness probe: ESRCH means the group is gone, EPERM means the tree is not
 * ours to kill, a clean return means members are still running.
 */
export async function posixKillTree(
	pid: number,
	options: {
		readonly graceMs?: number;
		readonly clock?: KillTreeClock;
		readonly signal?: AbortSignal;
		readonly emit?: KillTreeEmit;
	} = {},
): Promise<KillTreeResult> {
	const graceMs = options.graceMs ?? KILL_TREE_GRACE_MS;
	const clock = options.clock ?? { now: () => new Date().toISOString() };
	const attempts: KillTreeAttempt[] = [];

	const attempt = (
		method: KillTreeAttemptMethod,
		nativeSignal: NodeJS.Signals,
	): KillTreeAttemptResult => {
		const result = signalGroup(pid, nativeSignal);
		const record: KillTreeAttempt = Object.freeze({
			attempt: attempts.length + 1,
			method,
			result,
			at: clock.now(),
		});
		attempts.push(record);
		options.emit?.(Object.freeze({ phase: 'attempt', pid, attempt: record }));
		return result;
	};

	const initial = attempt('sigterm', 'SIGTERM');
	if (initial === 'terminated' || initial === 'not-process-owner') {
		return finish(pid, initial, attempts, options.emit);
	}

	await delay(graceMs, options.signal);

	const forced = attempt('sigkill', 'SIGKILL');
	return finish(pid, forced, attempts, options.emit);
}

function signalGroup(pid: number, signal: NodeJS.Signals): KillTreeAttemptResult {
	try {
		process.kill(-pid, signal);
		return 'still-running';
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code === 'ESRCH') return 'terminated';
		if (code === 'EPERM') return 'not-process-owner';
		return 'still-running';
	}
}

function finish(
	pid: number,
	lastResult: KillTreeAttemptResult,
	attempts: readonly KillTreeAttempt[],
	emit?: KillTreeEmit,
): KillTreeResult {
	const outcome =
		lastResult === 'terminated'
			? 'terminated'
			: lastResult === 'not-process-owner'
				? 'not-process-owner'
				: 'survived';
	emit?.(Object.freeze({ phase: 'outcome', pid, outcome, attempts: Object.freeze([...attempts]) }));
	return Object.freeze({ outcome, attempts });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, milliseconds);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(Object.assign(new Error('Aborted.'), { name: 'AbortError' }));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}
