import type {
	KillTreeAttempt,
	KillTreeAttemptMethod,
	KillTreeAttemptResult,
	KillTreeEmit,
	KillTreeOptions,
	KillTreeProcessOps,
	KillTreeResult,
} from './kill-tree-contract.ts';
import { KILL_TREE_GRACE_MS } from './kill-tree-contract.ts';

/**
 * Managed POSIX children occupy independent process groups. The proc layer
 * performs native signals and probes; this adapter owns TERM/KILL escalation.
 */
export async function posixKillTree(
	pid: number,
	processOps: KillTreeProcessOps,
	options: KillTreeOptions = {},
): Promise<KillTreeResult> {
	const attempts: KillTreeAttempt[] = [];
	const attempt = (method: KillTreeAttemptMethod, signal: 'SIGTERM' | 'SIGKILL') => {
		const result = processOps.signalGroup(pid, signal);
		recordAttempt(pid, method, result, processOps, attempts, options.emit);
		return result;
	};

	const initial = attempt('sigterm', 'SIGTERM');
	if (initial !== 'still-running') return finish(pid, initial, attempts, options.emit);

	await processOps.wait(options.graceMs ?? KILL_TREE_GRACE_MS);
	const afterGrace = processOps.probeGroup(pid);
	if (afterGrace !== 'still-running') return finish(pid, afterGrace, attempts, options.emit);

	const forced = attempt('sigkill', 'SIGKILL');
	return finish(pid, forced, attempts, options.emit);
}

export function recordAttempt(
	pid: number,
	method: KillTreeAttemptMethod,
	result: KillTreeAttemptResult,
	processOps: Pick<KillTreeProcessOps, 'now'>,
	attempts: KillTreeAttempt[],
	emit?: KillTreeEmit,
): void {
	const attempt = Object.freeze({
		attempt: attempts.length + 1,
		method,
		result,
		at: processOps.now(),
	});
	attempts.push(attempt);
	emit?.(Object.freeze({ phase: 'attempt', pid, attempt }));
}

export function finish(
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
	const frozenAttempts = Object.freeze([...attempts]);
	emit?.(Object.freeze({ phase: 'outcome', pid, outcome, attempts: frozenAttempts }));
	return Object.freeze({ outcome, attempts: frozenAttempts });
}
