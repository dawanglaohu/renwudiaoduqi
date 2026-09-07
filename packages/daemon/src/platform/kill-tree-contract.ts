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

/** Emitted per attempt (phase 'attempt') and once at the end (phase 'outcome'). */
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

export interface KillTreeClock {
	readonly now: () => string;
}

export type KillTreeEmit = (event: KillTreeEvent) => void;
