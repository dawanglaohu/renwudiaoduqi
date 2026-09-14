import type {
	CleanupTaskWorktreeResponse,
	GetTaskLandingResponse,
} from '@agent-scheduler/shared/api/tasks';
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

export type LandingServiceDeps = TaskLandingServiceDeps;

export function createLandingService(deps: LandingServiceDeps): LandingService {
	return createWorkspaceLandingService(deps);
}
