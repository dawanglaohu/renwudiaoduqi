import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
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
import { publishPendingEvents } from '../events/publish-pending.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import type {
	KillTreeOptions,
	KillTreeProcessOps,
	KillTreeResult,
} from '../platform/kill-tree-contract.ts';
import { posixKillTree } from '../platform/kill-tree-posix.ts';
import { windowsKillTree } from '../platform/windows.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type { GatesRepo } from '../repo/gates.ts';
import type { RunsAbortRepo } from '../repo/runs-abort-repo.ts';
import type { ArchiveTaskContext, SessionArchiveService } from './session-archive.ts';

export type { RunAbortRunRecord, RunsAbortRepo } from '../repo/runs-abort-repo.ts';

/**
 * Reason recorded when aborting a run whose worktree contains unaccepted changes (E-118).
 */
export const REASON_ABORTED_WITH_UNREVIEWED_CHANGES = '已中止（有未验收改动）';

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
	readonly runsRepo: RunsAbortRepo;
	readonly processOps: KillTreeProcessOps;
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
	readonly worktreeInspector?: WorktreeInspector;
	readonly sessionArchiveService?: SessionArchiveService;
	readonly gatesRepo?: Pick<GatesRepo, 'supersedePendingByRunIds'>;
}

export interface RunAbortService {
	abortRun(input: AbortRunInput): Promise<AbortRunResult>;
}

function normalizeInput(input: AbortRunInput): AbortRunInputObject {
	if (typeof input === 'string') {
		return { runId: input };
	}
	return input;
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
	const killTreeFn = deps.killTree ?? (deps.platform === 'win32' ? windowsKillTree : posixKillTree);

	return {
		async abortRun(rawInput: AbortRunInput): Promise<AbortRunResult> {
			const input = normalizeInput(rawInput);
			let run = deps.runsRepo.findById(input.runId);
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

			// Inspection can yield to process exit or another device's stop request.
			const latest = deps.runsRepo.findById(run.id);
			if (!latest) throw new AppError('E_NOT_FOUND', `Run not found: ${run.id}`);
			if (isTerminalRunState(latest.state)) {
				return Object.freeze({
					accepted: true,
					runId: latest.id,
					previousState: latest.state,
					currentState: latest.state,
					hasUnreviewedChanges,
					changedFileCount: detectedFileCount,
					alreadyTerminal: true,
				});
			}
			run = latest;
			assertValidTransition(run.state, 'aborted', { reason: input.reason });

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
			const pendingEvents: EventEnvelope[] = [];
			let archiveContext: ArchiveTaskContext | undefined;

			const executeDbUpdate = () => {
				deps.runsRepo.updateState({
					id: run.id,
					fromState: run.state,
					toState: 'aborted',
					endedAt: now,
					actorDeviceId,
					changedFileCount: detectedFileCount,
					queuedReason: finalReason,
				});
				if ((!run.kind || run.kind === 'implement') && deps.sessionArchiveService) {
					archiveContext = deps.sessionArchiveService.archiveTaskInTx({
						taskId: run.taskId,
						runId: run.id,
						actorDeviceId,
						now,
					});
				}
				deps.gatesRepo?.supersedePendingByRunIds?.(archiveContext?.archivedRunIds ?? [run.id], now);
				// Admission failure must roll back the stop before it can become idempotent.
				if (deps.bus && deps.envelopeFactory) {
					pendingEvents.push(
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

					pendingEvents.push(
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
					if (archiveContext?.laneReleased) {
						pendingEvents.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'lane.released',
								runId: run.id,
								taskId: run.taskId,
								actorDeviceId,
								payload: {
									docId: archiveContext.docId,
									laneNo: archiveContext.laneNo,
									taskId: run.taskId,
									runId: run.id,
									reason: 'aborted',
								},
							}),
						);
					}
				}
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(executeDbUpdate);
			} else {
				executeDbUpdate();
			}

			publishPendingEvents(pendingEvents, deps);

			// Persist the stop before signalling: exit callbacks must observe the terminal state.
			let killTreeResult: KillTreeResult | undefined;
			const managed = deps.processRegistry?.get(run.id);
			if (!archiveContext || !managed) {
				if (managed && !managed.isExited) {
					killTreeResult = await managed.kill({ graceMs: input.graceMs });
				} else if (run.pid !== null && run.pid > 0) {
					killTreeResult = await killTreeFn(run.pid, deps.processOps, { graceMs: input.graceMs });
				}
			}
			if (archiveContext && deps.sessionArchiveService) {
				await deps.sessionArchiveService.terminateArchived(archiveContext);
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
