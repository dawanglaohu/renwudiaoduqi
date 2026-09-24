import type { EffortTier } from '@agent-scheduler/shared/api/agents';
import type {
	AssignmentResolutionSource,
	AssignmentSnapshot,
} from '@agent-scheduler/shared/api/runs';
import type { TaskAssignmentValue } from '../domain/assignment.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';

export interface AssignmentReaderDispatchSnapshotsRepo {
	findById(id: string): {
		readonly id?: string;
		readonly assignment_json?: string | null;
	} | null;
}

export interface AssignmentReaderDeps {
	readonly runsRepo: RunsRepo;
	readonly dispatchSnapshotsRepo?: AssignmentReaderDispatchSnapshotsRepo | null;
}

export interface AssignmentReader {
	readonly readTaskAssignment: (implRunId: string) => TaskAssignmentValue | null;
	readonly serializeTaskAssignment: (assignment: AssignmentSnapshot) => string;
	readonly getFollowedTaskId: (snapshotId: string) => string | null;
	readonly getRawAssignmentJson: (
		snapshot:
			| { readonly assignment_json?: string | null }
			| Record<string, unknown>
			| null
			| undefined,
	) => string | null;
}

/**
 * Creates the reader for task assignment snapshots (AC 2, AC 3, E-341, E-343).
 *
 * Rules:
 * 1. Reads assignment_json from the snapshot referenced by the run.
 * 2. If assignment_json is NULL (legacy snapshot), synthesizes assignment from the first run
 *    row belonging to that snapshot without backfilling database.
 * 3. assignment_json literal is strictly isolated to this file and repo/dispatch-snapshots.ts.
 */
export function createAssignmentReader(deps: AssignmentReaderDeps): AssignmentReader {
	function readTaskAssignment(implRunId: string): TaskAssignmentValue | null {
		const run = deps.runsRepo.findById(implRunId);
		if (!run) {
			return null;
		}

		const snapshotId = run.snapshot_id;
		if (snapshotId && deps.dispatchSnapshotsRepo) {
			const snapshot = deps.dispatchSnapshotsRepo.findById(snapshotId);
			if (snapshot?.assignment_json) {
				try {
					const parsed = JSON.parse(snapshot.assignment_json) as AssignmentSnapshot;
					return Object.freeze({
						agentId: parsed.agentId,
						modelName: parsed.modelName ?? null,
						effortTier: parsed.effortTier ?? null,
						effortVendor: parsed.effortVendor ?? null,
						source: parsed.source ?? 'task',
						followedTaskId: parsed.followedTaskId ?? null,
						capturedAt: parsed.capturedAt,
					});
				} catch {
					// Fall through to run synthesis if json is corrupted
				}
			}

			// If snapshot assignment_json is NULL or unparsable, synthesize from the earliest run of this snapshot
			let baseRun: RunRow = run;
			if (run.task_id) {
				const taskRuns = deps.runsRepo.listByTaskId(run.task_id);
				const snapshotRuns = taskRuns.filter((r) => r.snapshot_id === snapshotId);
				if (snapshotRuns.length > 0) {
					baseRun = snapshotRuns.reduce((prev, curr) =>
						curr.attempt_no < prev.attempt_no ? curr : prev,
					);
				}
			}

			return Object.freeze({
				agentId: baseRun.agent_id,
				modelName: baseRun.model_name ?? null,
				effortTier: (baseRun.effort_tier as EffortTier) ?? null,
				effortVendor: baseRun.effort_vendor ?? null,
				source: (baseRun.assignment_source as AssignmentResolutionSource) ?? 'task',
				followedTaskId: null,
				capturedAt: baseRun.started_at ?? undefined,
			});
		}

		// Direct fallback from run row when no snapshotId
		return Object.freeze({
			agentId: run.agent_id,
			modelName: run.model_name ?? null,
			effortTier: (run.effort_tier as EffortTier) ?? null,
			effortVendor: run.effort_vendor ?? null,
			source: (run.assignment_source as AssignmentResolutionSource) ?? 'task',
			followedTaskId: null,
			capturedAt: run.started_at ?? undefined,
		});
	}

	function serializeTaskAssignment(assignment: AssignmentSnapshot): string {
		return JSON.stringify(assignment);
	}

	function getFollowedTaskId(snapshotId: string): string | null {
		if (!deps.dispatchSnapshotsRepo) {
			return null;
		}
		const snapshot = deps.dispatchSnapshotsRepo.findById(snapshotId);
		if (snapshot?.assignment_json) {
			try {
				const parsed = JSON.parse(snapshot.assignment_json) as AssignmentSnapshot;
				return parsed.followedTaskId ?? null;
			} catch {
				return null;
			}
		}
		return null;
	}

	function getRawAssignmentJson(
		snapshot:
			| { readonly assignment_json?: string | null }
			| Record<string, unknown>
			| null
			| undefined,
	): string | null {
		return ((snapshot as { readonly assignment_json?: string | null })?.assignment_json ?? null) as
			| string
			| null;
	}

	return Object.freeze({
		readTaskAssignment,
		serializeTaskAssignment,
		getFollowedTaskId,
		getRawAssignmentJson,
	});
}
