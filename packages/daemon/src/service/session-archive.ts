import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type {
	KillTreeOptions,
	KillTreeProcessOps,
	KillTreeResult,
} from '../platform/kill-tree-contract.ts';
import { posixKillTree } from '../platform/kill-tree-posix.ts';
import { windowsKillTree } from '../platform/windows.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type { RunRow } from '../repo/runs.ts';

export interface ArchiveTaskInTxInput {
	readonly taskId: string;
	readonly runId: string;
	readonly actorDeviceId?: string | null;
	readonly now?: string;
}

export interface ArchiveTaskContext {
	readonly taskId: string;
	readonly runId: string;
	readonly archivedRunIds: readonly string[];
	readonly runsToKill: readonly { readonly id: string; readonly pid: number }[];
	readonly laneReleased: boolean;
	readonly laneNo: number | null;
	readonly docId: string | null;
	readonly actorDeviceId?: string | null;
}

export interface TerminateArchivedResult {
	readonly taskId: string;
	readonly runIds: readonly string[];
	readonly killedPids: readonly number[];
	readonly residualPids: readonly number[];
	readonly phase1DurationMs: number;
	readonly phase2DurationMs: number;
	readonly envelope: EventEnvelope;
}

export interface SessionArchiveServiceDeps {
	readonly runsRepo: {
		readonly markSessionsArchived: (input: {
			readonly taskId: string;
			readonly archivedAt: string;
		}) => {
			readonly runIds: readonly string[];
			readonly runs: readonly { readonly id: string; readonly pid: number | null }[];
			readonly changes: number;
		};
		readonly listByTaskId?: (taskId: string) => readonly RunRow[];
		readonly listByTask?: (taskId: string) => readonly RunRow[];
	};
	readonly tasksRepo: {
		readonly clearLaneNo: (taskId: string) => {
			readonly changes: number;
			readonly previousLaneNo: number | null;
			readonly docId: string | null;
		};
	};
	readonly processRegistry?: ProcessRegistry;
	readonly clock: { readonly now: () => string };
	readonly envelopeFactory: EnvelopeFactory;
	readonly bus?: EventBus;
	readonly killTree?: (
		pid: number,
		processOps: KillTreeProcessOps,
		options?: KillTreeOptions,
	) => Promise<KillTreeResult>;
	readonly processOps?: KillTreeProcessOps;
	readonly platform?: NodeJS.Platform;
	readonly logger?: {
		readonly info?: (data: unknown, msg?: string) => void;
		readonly warn?: (data: unknown, msg?: string) => void;
	};
}

export interface SessionArchiveService {
	archiveTaskInTx(input: ArchiveTaskInTxInput): ArchiveTaskContext;
	terminateArchived(context: ArchiveTaskContext): Promise<TerminateArchivedResult>;
}

/**
 * Service orchestrating task session archiving and process tree termination (M6-T10, E-302, E-322).
 *
 * Rules:
 * 1. Exactly one trigger point: when kind='implement' transitions to landed/failed/aborted/interrupted (AC 1).
 * 2. In transaction: batch-mark session_archived_at, clear tasks.lane_no (collect lane.released if changes===1).
 *    Strictly NO await, NO killTree, NO publish inside transaction (E-302).
 * 3. After transaction: terminate process trees of non-null PIDs held by process registry via 2-stage killTree.
 *    Any survived processes are collected into residualPids without blocking slot release (AC 2, E-322).
 * 4. Publish task.sessions_archived{taskId, runIds, killedPids, residualPids} after killTree finishes (AC 2).
 * 5. Log audit entries according to Section 16 point 15 (AC 7).
 */
export function createSessionArchiveService(
	deps: SessionArchiveServiceDeps,
): SessionArchiveService {
	const defaultKillTree =
		deps.killTree ?? (deps.platform === 'win32' ? windowsKillTree : posixKillTree);

	return Object.freeze({
		archiveTaskInTx(input: ArchiveTaskInTxInput): ArchiveTaskContext {
			const now = input.now ?? deps.clock.now();

			// 1. Batch mark session_archived_at on all unarchived runs of the task
			const archiveResult = deps.runsRepo.markSessionsArchived({
				taskId: input.taskId,
				archivedAt: now,
			});

			const runsToKill: Array<{ id: string; pid: number }> = [];
			for (const r of archiveResult.runs) {
				if (r.pid !== null && r.pid > 0) {
					runsToKill.push({ id: r.id, pid: r.pid });
				}
			}

			// 2. Set tasks.lane_no to NULL (changes === 1 means a lane slot was held and released)
			const laneResult = deps.tasksRepo.clearLaneNo(input.taskId);
			const laneReleased = laneResult.changes === 1;

			return Object.freeze({
				taskId: input.taskId,
				runId: input.runId,
				archivedRunIds: archiveResult.runIds,
				runsToKill: Object.freeze(runsToKill),
				laneReleased,
				laneNo: laneResult.previousLaneNo,
				docId: laneResult.docId,
				actorDeviceId: input.actorDeviceId ?? null,
			});
		},

		async terminateArchived(context: ArchiveTaskContext): Promise<TerminateArchivedResult> {
			const killedPids: number[] = [];
			const residualPids: number[] = [];
			// phase1DurationMs: grace wait between attempt[0] and attempt[1]; phase2DurationMs: after attempt[1]
			let phase1TotalMs = 0;
			let phase2TotalMs = 0;

			for (const run of context.runsToKill) {
				const managed =
					deps.processRegistry?.get(run.id) ?? deps.processRegistry?.getByPid(run.pid);

				// Only terminate runs where PID is non-null AND the registry still holds the process
				if (!managed && !deps.processRegistry?.has(run.id)) {
					continue;
				}

				try {
					let killResult: KillTreeResult | undefined;
					if (
						managed &&
						typeof (managed as { kill?: () => Promise<KillTreeResult> }).kill === 'function'
					) {
						killResult = await (managed as { kill: () => Promise<KillTreeResult> }).kill();
					} else if (deps.processOps) {
						killResult = await defaultKillTree(run.pid, deps.processOps);
					}

					if (killResult) {
						if (killResult.outcome === 'terminated') {
							killedPids.push(run.pid);
						} else {
							// 'survived' and 'not-process-owner' (EPERM) both mean process still lives (E-322)
							residualPids.push(run.pid);
						}
						// Accumulate per-phase durations from attempt timestamps (Section 16 point 15, R4)
						const attempts = killResult.attempts;
						const a0 = attempts[0];
						const a1 = attempts[1];
						if (a0 !== undefined && a1 !== undefined) {
							phase1TotalMs += Math.max(0, Date.parse(a1.at) - Date.parse(a0.at));
							phase2TotalMs += Math.max(0, Date.now() - Date.parse(a1.at));
						} else if (a0 !== undefined) {
							phase1TotalMs += Math.max(0, Date.now() - Date.parse(a0.at));
						}
					} else {
						killedPids.push(run.pid);
					}
				} catch {
					// Termination error or still running is recorded as residual
					residualPids.push(run.pid);
				} finally {
					// Clean registry record
					deps.processRegistry?.unregister(run.id);
				}
			}

			// Section 16 point 15 observability logging (with two-phase durations, R4)
			const logData = {
				taskId: context.taskId,
				archivedRunCount: context.archivedRunIds.length,
				killTreePidCount: killedPids.length + residualPids.length,
				killedPids,
				residualPids,
				phase1DurationMs: phase1TotalMs,
				phase2DurationMs: phase2TotalMs,
			};
			if (residualPids.length > 0) {
				deps.logger?.warn?.(
					logData,
					`Session archive completed with ${residualPids.length} residual process(es)`,
				);
			} else {
				deps.logger?.info?.(logData, 'Session archive completed successfully');
			}

			// Publish task.sessions_archived event
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'task.sessions_archived',
				taskId: context.taskId,
				runId: context.runId,
				actorDeviceId: context.actorDeviceId ?? null,
				payload: {
					taskId: context.taskId,
					runIds: context.archivedRunIds,
					killedPids: Object.freeze(killedPids),
					residualPids: Object.freeze(residualPids),
				},
			});

			if (deps.bus) {
				deps.bus.publish(envelope);
			}

			return Object.freeze({
				taskId: context.taskId,
				runIds: context.archivedRunIds,
				killedPids: Object.freeze(killedPids),
				residualPids: Object.freeze(residualPids),
				phase1DurationMs: phase1TotalMs,
				phase2DurationMs: phase2TotalMs,
				envelope,
			});
		},
	});
}
