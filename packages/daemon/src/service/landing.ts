import type {
	CleanupTaskWorktreeResponse,
	GetTaskLandingResponse,
} from '@agent-scheduler/shared/api/tasks';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { RunsRepo } from '../repo/runs.ts';
import {
	type CleanupTaskWorktreeInput,
	type GenerateLandingCommandsOptions,
	type GetTaskLandingInput,
	type TaskLandingServiceDeps,
	createLandingService as createWorkspaceLandingService,
} from '../workspace/landing.ts';

/**
 * Application-facing seam for the task landing checklist and worktree disposal (E-73, E-74).
 *
 * The git and worktree knowledge stays in `workspace/landing.ts`; this layer exists so that
 * HTTP routes and the container depend on `service` only, never on `workspace` or `repo`
 * (08 节 layering).
 */
export interface LandingService {
	readonly getLanding: (input: GetTaskLandingInput) => Promise<GetTaskLandingResponse>;
	readonly cleanupWorktree: (
		input: CleanupTaskWorktreeInput,
	) => Promise<CleanupTaskWorktreeResponse>;
	readonly generateLandingCommands: (options: GenerateLandingCommandsOptions) => readonly string[];
}

export type LandingServiceDeps = TaskLandingServiceDeps & {
	readonly runsRepo?: RunsRepo;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
};

function duplicateFixLandingHints(taskId: string, deps: LandingServiceDeps): readonly string[] {
	const runs = deps.runsRepo?.listByTaskId(taskId) ?? [];
	const latestFix = runs
		.filter((run) => run.origin === 'wrapup-fix')
		.reduce<(typeof runs)[number] | null>(
			(latest, run) => (!latest || run.attempt_no > latest.attempt_no ? run : latest),
			null,
		);
	const prompt = latestFix?.snapshot_id
		? deps.dispatchSnapshotsRepo?.findById(latestFix.snapshot_id)?.impl_prompt
		: null;
	const marker = '## 补充修复要求（重复判修）';
	const markerIndex = prompt?.indexOf(marker) ?? -1;
	if (!prompt || markerIndex < 0) return [];
	return Object.freeze(
		prompt
			.slice(markerIndex + marker.length)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.startsWith('- ')),
	);
}

export function createLandingService(deps: LandingServiceDeps): LandingService {
	const workspaceLanding = createWorkspaceLandingService(deps);
	return Object.freeze({
		...workspaceLanding,
		async getLanding(input: GetTaskLandingInput) {
			const landing = await workspaceLanding.getLanding(input);
			const task = deps.tasksRepo?.findById(input.taskId);
			return Object.freeze({
				...landing,
				landingHints: task ? duplicateFixLandingHints(task.id, deps) : [],
			});
		},
	});
}
