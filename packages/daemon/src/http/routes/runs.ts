import type { CreateRunMessageBody } from '@agent-scheduler/shared/api/runs';
import { createRunMessageBodySchema } from '@agent-scheduler/shared/api/runs';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { MessageService } from '../../service/message.ts';
import type { RunAbortService } from '../../service/run-abort.ts';
import type { RunLogService } from '../../service/run-log.ts';

export interface AbortRunParams {
	readonly id?: string;
	readonly runId?: string;
}

export const ABORT_RUN_PARAMS_PROPERTIES = [
	'id',
	'runId',
] as const satisfies readonly (keyof AbortRunParams)[];

export const abortRunParamsSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1 },
		runId: { type: 'string', minLength: 1 },
	},
} as const;

export interface AbortRunBody {
	readonly reason?: string;
}

export const ABORT_RUN_BODY_PROPERTIES = [
	'reason',
] as const satisfies readonly (keyof AbortRunBody)[];

export const abortRunBodySchema = {
	type: 'object',
	nullable: true,
	additionalProperties: false,
	properties: {
		reason: { type: 'string' },
	},
} as const;

export interface RunMessageParams {
	readonly id?: string;
	readonly runId?: string;
}

export const RUN_MESSAGE_PARAMS_PROPERTIES = [
	'id',
	'runId',
] as const satisfies readonly (keyof RunMessageParams)[];

export const runMessageParamsSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1 },
		runId: { type: 'string', minLength: 1 },
	},
} as const;

export interface GetRunLogParams {
	readonly id?: string;
	readonly runId?: string;
}

export const GET_RUN_LOG_PARAMS_PROPERTIES = [
	'id',
	'runId',
] as const satisfies readonly (keyof GetRunLogParams)[];

export const getRunLogParamsSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1 },
		runId: { type: 'string', minLength: 1 },
	},
} as const;

export { createRunMessageBodySchema };

export interface GetRunLogQuery {
	readonly fromSeq?: number;
	readonly direction?: 'forward' | 'backward';
	readonly limit?: number;
	readonly deviceType?: string;
	readonly redact?: boolean;
}

export const GET_RUN_LOG_QUERY_PROPERTIES = [
	'deviceType',
	'direction',
	'fromSeq',
	'limit',
	'redact',
] as const satisfies readonly (keyof GetRunLogQuery)[];

export const getRunLogQuerySchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		fromSeq: { type: 'integer', minimum: 0 },
		direction: { type: 'string', enum: ['forward', 'backward'] },
		limit: { type: 'integer', minimum: 1, maximum: 2000 },
		deviceType: { type: 'string' },
		redact: { type: 'boolean' },
	},
} as const;

export interface RegisterRunsRoutesOptions {
	readonly runAbortService?: RunAbortService;
	readonly messageService?: MessageService;
	readonly runLogService?: RunLogService;
}

interface ContainerWithServices {
	readonly services?: {
		readonly runAbort?: RunAbortService;
		readonly message?: MessageService;
		readonly runLog?: RunLogService;
	};
}

/**
 * Registers run management routes:
 * - `POST /api/v1/runs/:id/abort` (10-接口约定 端点总表)
 * - `POST /api/v1/runs/:id/messages` (10-接口约定 端点总表 / M6-T6)
 * - `GET /api/v1/runs/:runId/log` (10-接口约定 端点总表, M6-T8)
 */
export function registerRunsRoutes(
	instance: FastifyInstance,
	options?: RegisterRunsRoutesOptions,
): void {
	const abortHandler: RouteHandlerMethod = async (request) => {
		const params = request.params as AbortRunParams;
		const body = (request.body ?? {}) as AbortRunBody;

		const container = request.server.container as ContainerWithServices | undefined;
		const service = options?.runAbortService ?? container?.services?.runAbort;

		if (!service) {
			throw new AppError('E_INTERNAL', 'RunAbortService is not available in container');
		}

		const runId = params.runId ?? params.id ?? '';
		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		const result = await service.abortRun({
			runId,
			reason: body.reason,
			actorDeviceId,
		});

		return {
			accepted: result.accepted,
		};
	};

	instance.post<{
		Params: AbortRunParams;
		Body: AbortRunBody;
	}>(
		'/api/v1/runs/:runId/abort',
		{
			schema: {
				params: abortRunParamsSchema,
				body: abortRunBodySchema,
			},
		},
		abortHandler,
	);

	const messageHandler: RouteHandlerMethod = async (request) => {
		const params = request.params as RunMessageParams;
		const body = request.body as CreateRunMessageBody;

		const container = request.server.container as ContainerWithServices | undefined;
		const service = options?.messageService ?? container?.services?.message;

		if (!service) {
			throw new AppError('E_INTERNAL', 'MessageService is not available in container');
		}

		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;
		const runId = params.runId ?? params.id ?? '';

		const result = await service.sendMessage({
			runId,
			text: body.text,
			kind: body.kind,
			actorDeviceId,
			throwOnUndelivered: true,
		});

		return {
			delivered: result.delivered,
			messageId: result.messageId,
		};
	};

	instance.post<{
		Params: RunMessageParams;
		Body: CreateRunMessageBody;
	}>(
		'/api/v1/runs/:runId/messages',
		{
			schema: {
				params: runMessageParamsSchema,
				body: createRunMessageBodySchema,
			},
		},
		messageHandler,
	);

	const logHandler: RouteHandlerMethod = async (request) => {
		const params = request.params as GetRunLogParams;
		const query = (request.query ?? {}) as GetRunLogQuery;

		const container = request.server.container as ContainerWithServices | undefined;
		const service = options?.runLogService ?? container?.services?.runLog;

		if (!service) {
			throw new AppError('E_INTERNAL', 'RunLogService is not available in container');
		}

		const runId = params.runId ?? params.id ?? '';
		if (!runId) {
			throw new AppError('E_VALIDATION', 'runId is required');
		}

		const headers = request.headers;
		const userAgent = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : '';
		const xDeviceType =
			typeof headers['x-device-type'] === 'string' ? headers['x-device-type'] : '';

		const isMobile =
			query.deviceType === 'mobile' ||
			query.redact === true ||
			xDeviceType === 'mobile' ||
			/Mobile|Android|iPhone|iPad|Capacitor/i.test(userAgent);

		const result = await service.getRunLog({
			runId,
			fromSeq: query.fromSeq,
			direction: query.direction,
			limit: query.limit,
			isMobileDevice: isMobile,
		});

		return {
			lines: result.lines,
			totalLines: result.totalLines,
			prevCursor: result.prevCursor,
			nextCursor: result.nextCursor,
		};
	};

	instance.get<{
		Params: GetRunLogParams;
		Querystring: GetRunLogQuery;
	}>(
		'/api/v1/runs/:runId/log',
		{
			schema: {
				params: getRunLogParamsSchema,
				querystring: getRunLogQuerySchema,
			},
		},
		logHandler,
	);
}
