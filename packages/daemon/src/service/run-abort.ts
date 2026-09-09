import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import {
	RUN_TRANSITION_REASONS,
	type RunState,
	type RunStateMachine,
	assertValidTransition,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import type {
	KillTreeOptions,
	KillTreeProcessOps,
	KillTreeResult,
} from '../platform/kill-tree-contract.ts';
import { posixKillTree } from '../platform/kill-tree-posix.ts';
import { windowsKillTree } from '../platform/windows.ts';
import type { ProcessRegistry } from '../proc/registry.ts';

/**
 * Reason recorded when aborting a run whose worktree contains unaccepted changes (E-118).
 */
export const REASON_ABORTED_WITH_UNREVIEWED_CHANGES = '已中止（有未验收改动）';

export interface RunAbortRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly state: RunState;
	readonly pid: number | null;
	readonly worktreePath: string | null;
	readonly changedFileCount: number | null;
}

export interface RunsAbortRepo {
	findById(id: string): RunAbortRunRecord | null;
	updateState(input: {
		readonly id: string;
		readonly fromState: RunState;
		readonly toState: RunState;
		readonly endedAt: string;
		readonly actorDeviceId?: string | null;
		readonly changedFileCount?: number | null;
		readonly queuedReason?: string | null;
	}): void;
}

export interface WorktreeInspectionResult {
	readonly hasChanges: boolean;
	readonly changedFileCount: number;
	readonly diff?: string;
}

export interface WorktreeInspector {
	inspect(worktreePath: string): Promise<WorktreeInspectionResult>;
}

export interface AbortRunInputObject {
	readonly runId: string;
	readonly reason?: string;
	readonly actorDeviceId?: string | null;
	readonly graceMs?: number;
}

export type AbortRunInput = string | AbortRunInputObject;

export interface AbortRunResult {
	readonly accepted: true;
	readonly runId: string;
	readonly previousState: RunState;
	readonly currentState: RunState;
	readonly hasUnreviewedChanges: boolean;
	readonly changedFileCount: number | null;
	readonly alreadyTerminal: boolean;
	readonly killTreeResult?: KillTreeResult;
}

export interface RunAbortServiceDeps {
	readonly runsRepo?: RunsAbortRepo;
	readonly database?: DatabaseConnection;
	readonly clock: { readonly now: () => string };
	readonly ids?: { readonly newId: () => string };
	readonly unitOfWork?: UnitOfWork;
	readonly stateMachine?: RunStateMachine;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly processRegistry?: ProcessRegistry;
	readonly platform?: SupportedPlatform;
	readonly killTree?: (
		pid: number,
		processOps: KillTreeProcessOps,
		options?: KillTreeOptions,
	) => Promise<KillTreeResult>;
	readonly processOps?: KillTreeProcessOps;
	readonly worktreeInspector?: WorktreeInspector;
}

export interface RunAbortService {
	abortRun(input: AbortRunInput): Promise<AbortRunResult>;
}

export function createSqliteRunsAbortRepo(db: DatabaseConnection): RunsAbortRepo {
	const selectStmt = db.prepare(`
		SELECT id, task_id, state, pid, worktree_path, changed_file_count
		FROM runs
		WHERE id = ?
		LIMIT 1
	`);

	const updateStmt = db.prepare(`
		UPDATE runs
		SET state = @toState,
		    ended_at = @endedAt,
		    actor_device_id = @actorDeviceId,
		    changed_file_count = @changedFileCount,
		    queued_reason = @queuedReason
		WHERE id = @id AND state = @fromState
	`);

	return {
		findById(id: string): RunAbortRunRecord | null {
			try {
				const row = selectStmt.get(id) as
					| {
							id: string;
							task_id: string;
							state: RunState;
							pid: number | null;
							worktree_path: string | null;
							changed_file_count: number | null;
					  }
					| undefined;
				if (!row) return null;
				return {
					id: row.id,
					taskId: row.task_id,
					state: row.state,
					pid: row.pid,
					worktreePath: row.worktree_path,
					changedFileCount: row.changed_file_count,
				};
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsAbortRepo.findById');
			}
		},

		updateState(input): void {
			try {
				const result = updateStmt.run({
					id: input.id,
					fromState: input.fromState,
					toState: input.toState,
					endedAt: input.endedAt,
					actorDeviceId: input.actorDeviceId ?? null,
					changedFileCount: input.changedFileCount ?? null,
					queuedReason: input.queuedReason ?? null,
				});
				if (result.changes === 0) {
					throw new AppError(
						'E_INVALID_STATE_TRANSITION',
						`Run ${input.id} could not be updated from ${input.fromState} to ${input.toState}`,
					);
				}
			} catch (cause) {
				if (cause instanceof AppError) throw cause;
				throw toDatabaseError(cause, 'RunsAbortRepo.updateState');
			}
		},
	};
}

function normalizeInput(input: AbortRunInput): AbortRunInputObject {
	if (typeof input === 'string') {
		return { runId: input };
	}
	return input;
}

function createFallbackProcessOps(): KillTreeProcessOps {
	return {
		now: () => new Date().toISOString(),
		wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
		taskkill: async () => 'terminated',
		signalGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
			try {
				process.kill(-pid, signal);
				return signal === 'SIGKILL' ? 'terminated' : 'still-running';
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === 'ESRCH') return 'terminated';
				if (code === 'EPERM') return 'not-process-owner';
				return 'still-running';
			}
		},
		probeTree: async () => 'terminated',
		probeGroup: (pid: number) => {
			try {
				process.kill(-pid, 0);
				return 'still-running';
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === 'ESRCH') return 'terminated';
				if (code === 'EPERM') return 'not-process-owner';
				return 'still-running';
			}
		},
	};
}

/**
 * Service for aborting runs, terminating process trees, and settling state (M6-T5).
 *
 * Rules:
 * 1. Process termination strictly uses platform killTree; business logic never directly kills parent process (E-119).
 * 2. If worktree contains modifications at abort time, retains worktree and diff, records
 *    "已中止（有未验收改动）", and performs no automatic cleanup or rollback (E-118).
 * 3. Idempotent: returns accepted directly if the run is already in a terminal state.
 * 4. Provides disposal for orphaned runs (E-02), terminating their process tree and transitioning to aborted.
 */
export function createRunAbortService(deps: RunAbortServiceDeps): RunAbortService {
	const repo: RunsAbortRepo | undefined =
		deps.runsRepo ?? (deps.database ? createSqliteRunsAbortRepo(deps.database) : undefined);

	if (!repo) {
		throw new AppError('E_INTERNAL', 'RunAbortService requires either runsRepo or database');
	}

	const killTreeFn = deps.killTree ?? (deps.platform === 'win32' ? windowsKillTree : posixKillTree);

	return {
		async abortRun(rawInput: AbortRunInput): Promise<AbortRunResult> {
			const input = normalizeInput(rawInput);
			const run = repo.findById(input.runId);
			if (!run) {
				throw new AppError('E_NOT_FOUND', `Run not found: ${input.runId}`, {
					details: { runId: input.runId },
				});
			}

			// 1. Idempotency: return accepted directly if already terminal (AC 3)
			if (isTerminalRunState(run.state)) {
				return Object.freeze({
					accepted: true,
					runId: run.id,
					previousState: run.state,
					currentState: run.state,
					hasUnreviewedChanges: (run.changedFileCount ?? 0) > 0,
					changedFileCount: run.changedFileCount,
					alreadyTerminal: true,
				});
			}

			// 2. Validate state transition to 'aborted'
			if (deps.stateMachine) {
				deps.stateMachine.assertValidTransition(run.state, 'aborted', {
					reason: input.reason,
				});
			} else {
				assertValidTransition(run.state, 'aborted', { reason: input.reason });
			}

			// 3. Terminate process tree via platform killTree (AC 1, E-119, E-02)
			let killTreeResult: KillTreeResult | undefined;
			const managed = deps.processRegistry?.get(run.id);

			if (managed && !managed.isExited) {
				killTreeResult = await managed.kill({
					graceMs: input.graceMs,
				});
			} else if (run.pid !== null && run.pid > 0) {
				const ops = deps.processOps ?? createFallbackProcessOps();
				killTreeResult = await killTreeFn(run.pid, ops, {
					graceMs: input.graceMs,
				});
			}

			// 4. Inspect worktree changes (AC 2, E-118)
			let hasUnreviewedChanges = false;
			let detectedFileCount: number | null = run.changedFileCount;

			if (run.worktreePath && deps.worktreeInspector) {
				try {
					const inspection = await deps.worktreeInspector.inspect(run.worktreePath);
					if (inspection.hasChanges) {
						hasUnreviewedChanges = true;
						detectedFileCount = inspection.changedFileCount;
					}
				} catch {
					if (run.changedFileCount !== null && run.changedFileCount > 0) {
						hasUnreviewedChanges = true;
					}
				}
			} else if (run.changedFileCount !== null && run.changedFileCount > 0) {
				hasUnreviewedChanges = true;
			}

			// AC 2: Record "已中止（有未验收改动）" if worktree has changes
			const finalReason = hasUnreviewedChanges
				? REASON_ABORTED_WITH_UNREVIEWED_CHANGES
				: (input.reason ??
					(run.state === 'orphaned'
						? RUN_TRANSITION_REASONS.HUMAN_KILLED
						: RUN_TRANSITION_REASONS.MANUAL_ABORT));

			const now = deps.clock.now();
			const actorDeviceId = input.actorDeviceId ?? null;

			// 5. Update state inside UnitOfWork if present, collecting events to emit outside transaction
			let shouldPublishEvents = false;

			const executeDbUpdate = () => {
				repo.updateState({
					id: run.id,
					fromState: run.state,
					toState: 'aborted',
					endedAt: now,
					actorDeviceId,
					changedFileCount: detectedFileCount,
					queuedReason: finalReason,
				});
				shouldPublishEvents = true;
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(executeDbUpdate);
			} else {
				executeDbUpdate();
			}

			// 6. Publish events outside of transaction
			if (shouldPublishEvents && deps.bus && deps.envelopeFactory) {
				deps.bus.publish(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId: run.id,
						taskId: run.taskId,
						actorDeviceId,
						payload: {
							from: run.state,
							to: 'aborted',
							reason: finalReason,
						},
					}),
				);

				deps.bus.publish(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.aborted',
						runId: run.id,
						taskId: run.taskId,
						actorDeviceId,
						payload: {
							reason: finalReason,
							hasUnreviewedChanges,
							changedFileCount: detectedFileCount,
						},
					}),
				);
			}

			return Object.freeze({
				accepted: true,
				runId: run.id,
				previousState: run.state,
				currentState: 'aborted',
				hasUnreviewedChanges,
				changedFileCount: detectedFileCount,
				alreadyTerminal: false,
				killTreeResult,
			});
		},
	};
}
