import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { DatabaseConnection } from '../../db/open-database.ts';
import { AppError } from '../../errors/app-error.ts';
import type { PlatformHostInputs, SupportedPlatform } from '../../platform/contract.ts';
import { takePlatformHostInputs } from '../../platform/host.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../repo/documents.ts';
import { type TasksRepo, createTasksRepo } from '../../repo/tasks.ts';
import {
	type TaskLandingService,
	type TaskLandingServiceDeps,
	createLandingService,
} from '../../workspace/landing.ts';
import {
	type GitRunner,
	type WorktreeFileSystem,
	type WorktreeManagerDeps,
	createDefaultGitRunner,
} from '../../workspace/worktree.ts';

export interface TaskRouteParams {
	readonly taskId: string;
}

export const TASK_ROUTE_PARAMS_PROPERTIES = [
	'taskId',
] as const satisfies readonly (keyof TaskRouteParams)[];

export const taskRouteParamsSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['taskId'],
	properties: {
		taskId: { type: 'string', minLength: 1 },
	},
} as const;

export interface RegisterTasksRoutesOptions {
	readonly landingService?: TaskLandingService;
	readonly gitRunner?: GitRunner;
	readonly worktreeDeps?: WorktreeManagerDeps;
	readonly tasksRepo?: TasksRepo;
	readonly documentsRepo?: DocumentsRepo;
	readonly db?: DatabaseConnection;
	readonly repoPath?: string;
	readonly docsPath?: string;
	readonly platform?: SupportedPlatform;
	readonly hostInputs?: PlatformHostInputs;
	readonly fs?: WorktreeFileSystem;
}

interface ContainerWithServices {
	readonly database?: DatabaseConnection;
	readonly platform?: {
		readonly hostInputs?: PlatformHostInputs;
	};
	readonly ids?: {
		readonly newId: () => string;
	};
	readonly repos?: {
		readonly tasks?: TasksRepo;
		readonly documents?: DocumentsRepo;
	};
	readonly services?: {
		readonly landing?: TaskLandingService;
	};
}

function resolveLandingService(
	request: FastifyRequest,
	instance: FastifyInstance,
	options?: RegisterTasksRoutesOptions,
): TaskLandingService {
	if (options?.landingService) {
		return options.landingService;
	}

	const container =
		(request.server as unknown as { container?: ContainerWithServices })?.container ??
		(instance as unknown as { container?: ContainerWithServices })?.container;

	if (container?.services?.landing) {
		return container.services.landing;
	}

	const db = options?.db ?? container?.database;
	const tasksRepo =
		options?.tasksRepo ?? container?.repos?.tasks ?? (db ? createTasksRepo(db) : undefined);
	const documentsRepo =
		options?.documentsRepo ??
		container?.repos?.documents ??
		(db ? createDocumentsRepo(db) : undefined);

	const defaultHostResult = takePlatformHostInputs({});
	const defaultHostInputs = defaultHostResult.ok ? defaultHostResult.value : undefined;

	const hostInputs = options?.hostInputs ?? container?.platform?.hostInputs ?? defaultHostInputs;
	const platform = options?.platform ?? hostInputs?.platform ?? 'linux';
	const ids = container?.ids ?? { newId: () => randomUUID() };

	const worktreeDeps: WorktreeManagerDeps = options?.worktreeDeps ?? {
		platform,
		hostInputs,
		ids,
		fs: options?.fs,
		gitRunner: options?.gitRunner,
	};

	const runner =
		options?.gitRunner ?? worktreeDeps.gitRunner ?? createDefaultGitRunner(worktreeDeps);

	const serviceDeps: TaskLandingServiceDeps = {
		runner,
		worktreeDeps,
		tasksRepo,
		documentsRepo,
		db,
		platform,
		hostInputs,
		ids,
		fs: options?.fs,
		repoPath: options?.repoPath,
		docsPath: options?.docsPath,
	};

	return createLandingService(serviceDeps);
}

/**
 * Registers task routes:
 * - `GET /api/v1/tasks/:taskId/landing`: read-only landing checklist with diff and copyable commands (AC 1, AC 3, E-74)
 * - `POST /api/v1/tasks/:taskId/worktree/cleanup`: explicit worktree reclamation (AC 2, E-73)
 */
export function registerTasksRoutes(
	instance: FastifyInstance,
	options?: RegisterTasksRoutesOptions,
): void {
	const getLandingHandler: RouteHandlerMethod = async (request) => {
		const params = request.params as TaskRouteParams;
		if (!params || typeof params.taskId !== 'string' || params.taskId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'taskId is required and must be non-empty');
		}
		const service = resolveLandingService(request, instance, options);
		const landing = await service.getLanding({ taskId: params.taskId.trim() });
		return landing;
	};

	const cleanupWorktreeHandler: RouteHandlerMethod = async (request) => {
		const params = request.params as TaskRouteParams;
		if (!params || typeof params.taskId !== 'string' || params.taskId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'taskId is required and must be non-empty');
		}
		const service = resolveLandingService(request, instance, options);
		const cleanupResult = await service.cleanupWorktree({ taskId: params.taskId.trim() });
		return cleanupResult;
	};

	instance.get(
		'/api/v1/tasks/:taskId/landing',
		{
			schema: {
				params: taskRouteParamsSchema,
			},
		},
		getLandingHandler,
	);

	instance.post(
		'/api/v1/tasks/:taskId/worktree/cleanup',
		{
			schema: {
				params: taskRouteParamsSchema,
			},
		},
		cleanupWorktreeHandler,
	);
}
