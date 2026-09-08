export const KILL_TREE_GRACE_MS = 3000 as const;

export type KillTreeAttemptMethod = 'taskkill-soft' | 'taskkill-force' | 'sigterm' | 'sigkill';

export type KillTreeAttemptResult = 'still-running' | 'terminated' | 'not-process-owner';

export interface KillTreeAttempt {
	readonly attempt: number;
	readonly method: KillTreeAttemptMethod;
	readonly result: KillTreeAttemptResult;
	readonly at: string;
}

export type KillTreeOutcome = 'terminated' | 'survived' | 'not-process-owner';

/** Each termination attempt is emitted before one final outcome event. */
export interface KillTreeEvent {
	readonly phase: 'attempt' | 'outcome';
	readonly pid: number;
	readonly attempt?: KillTreeAttempt;
	readonly outcome?: KillTreeOutcome;
	readonly attempts?: readonly KillTreeAttempt[];
}

export interface KillTreeResult {
	readonly outcome: KillTreeOutcome;
	readonly attempts: readonly KillTreeAttempt[];
}

export type KillTreeEmit = (event: KillTreeEvent) => void;

/**
 * The proc layer owns native process APIs. Platform adapters only choose the
 * command, signal, grace period, and escalation policy.
 */
export interface KillTreeProcessOps {
	readonly now: () => string;
	readonly wait: (milliseconds: number) => Promise<void>;
	/** Exit 128 is ambiguous: stderr distinguishes an absent PID from a tree that still needs /F. */
	readonly taskkill: (args: readonly string[]) => Promise<KillTreeAttemptResult>;
	readonly signalGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => KillTreeAttemptResult;
	readonly probeTree: (pid: number) => Promise<KillTreeAttemptResult>;
	readonly probeGroup: (pid: number) => KillTreeAttemptResult;
}

export interface KillTreeOptions {
	readonly graceMs?: number;
	readonly emit?: KillTreeEmit;
}
