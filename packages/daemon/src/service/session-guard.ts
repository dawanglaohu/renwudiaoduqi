import { AppError } from '../errors/app-error.ts';
import type { RunRow } from '../repo/runs.ts';

export interface AssertSessionRefFreeInput {
	readonly taskId: string;
	readonly vendorSessionRef?: string | null;
}

export interface SessionGuardDeps {
	readonly runsRepo: {
		readonly findByVendorSessionRef: (ref: string) => RunRow | null;
		readonly findById?: (id: string) => RunRow | null;
	};
	readonly tasksRepo?: {
		readonly findById: (id: string) => { readonly task_key: string } | null;
	};
}

export interface SessionGuardService {
	assertSessionRefFree(input: AssertSessionRefFreeInput): void;
	assertNotArchived(
		runOrId:
			| RunRow
			| {
					readonly id: string;
					readonly session_archived_at?: string | null;
					readonly task_id?: string;
			  }
			| string,
	): void;
}

/**
 * Asserts that a vendor session reference is not shared across tasks (E-303, AC 5).
 * Reuses within the same task across rounds are permitted.
 */
export function assertSessionRefFree(
	input: AssertSessionRefFreeInput,
	deps: SessionGuardDeps,
): void {
	if (!input.vendorSessionRef || input.vendorSessionRef.trim().length === 0) {
		return;
	}

	const existing = deps.runsRepo.findByVendorSessionRef(input.vendorSessionRef);
	if (!existing) {
		return;
	}

	// Same task multi-round shared reference permitted (AC 5, E-303)
	if (existing.task_id === input.taskId) {
		return;
	}

	// Different task collision: reject with E_SESSION_ARCHIVED and conflictTaskKey
	const conflictTask = deps.tasksRepo?.findById(existing.task_id);
	const conflictTaskKey = conflictTask?.task_key ?? existing.task_id;

	throw new AppError(
		'E_SESSION_ARCHIVED',
		`Vendor session reference '${input.vendorSessionRef}' is already used by task '${conflictTaskKey}'.`,
		{
			details: {
				conflictTaskKey,
				conflictRunId: existing.id,
				vendorSessionRef: input.vendorSessionRef,
				taskId: input.taskId,
			},
		},
	);
}

/**
 * Asserts that a run's session has not been archived (AC 4, E-96, E-302).
 * Archived sessions are strictly read-only: messages, rework reinjection, and continuation are rejected.
 */
export function assertNotArchived(
	runOrId:
		| RunRow
		| {
				readonly id: string;
				readonly session_archived_at?: string | null;
				readonly task_id?: string;
		  }
		| string,
	deps?: SessionGuardDeps,
): void {
	let run: {
		readonly id: string;
		readonly session_archived_at?: string | null;
		readonly task_id?: string;
	} | null;

	if (typeof runOrId === 'string') {
		if (!deps?.runsRepo?.findById) {
			return;
		}
		run = deps.runsRepo.findById(runOrId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runOrId}`, {
				details: { runId: runOrId },
			});
		}
	} else {
		run = runOrId;
	}

	if (run.session_archived_at !== null && run.session_archived_at !== undefined) {
		throw new AppError(
			'E_SESSION_ARCHIVED',
			`Session for run '${run.id}' has been archived and is read-only.`,
			{
				details: {
					runId: run.id,
					taskId: run.task_id,
					sessionArchivedAt: run.session_archived_at,
				},
			},
		);
	}
}

export function createSessionGuardService(deps: SessionGuardDeps): SessionGuardService {
	return Object.freeze({
		assertSessionRefFree(input: AssertSessionRefFreeInput): void {
			assertSessionRefFree(input, deps);
		},
		assertNotArchived(
			runOrId:
				| RunRow
				| {
						readonly id: string;
						readonly session_archived_at?: string | null;
						readonly task_id?: string;
				  }
				| string,
		): void {
			assertNotArchived(runOrId, deps);
		},
	});
}
