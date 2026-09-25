import { ERROR_CODES, type ErrorCode } from '@agent-scheduler/shared/errors/codes';
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from 'fastify';
import { isAppError } from '../../errors/app-error.ts';

const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_CONFLICT = 409;
const STATUS_INTERNAL_ERROR = 500;

export interface ErrorEnvelope {
	readonly error: {
		readonly code: string;
		readonly message: string;
		readonly requestId: string;
		readonly details?: Record<string, unknown>;
		readonly stack?: string;
	};
}

export function createErrorHandler(instance: FastifyInstance): void {
	instance.setErrorHandler((error: FastifyError | Error, request, reply) => {
		const isDev = Boolean(request.server.container?.config?.dev);
		const requestId =
			request.id || (request.headers['x-request-id'] as string | undefined) || 'unknown';

		// 1. AppError check
		if (isAppError(error)) {
			const code = error.code;
			const meta = code in ERROR_CODES ? ERROR_CODES[code as ErrorCode] : undefined;

			// Unregistered code or client-only error code falls back to 500 E_INTERNAL
			if (!meta || meta.origin !== 'server' || typeof meta.defaultHttpStatus !== 'number') {
				request.log.error(error);
				const envelope: ErrorEnvelope = {
					error: {
						code: 'E_INTERNAL',
						message: 'An internal server error occurred.',
						requestId,
						...(isDev && error.stack ? { stack: error.stack } : {}),
					},
				};
				void reply.status(STATUS_INTERNAL_ERROR).send(envelope);
				return;
			}

			let statusCode = meta.defaultHttpStatus;
			// 只将 elevate_once 请求的非法状态映射为客户端冲突；其他状态机错误保留原有分类。
			if (code === 'E_INVALID_STATE_TRANSITION' && error.details?.operation === 'elevate_once') {
				statusCode = STATUS_CONFLICT;
			}

			const envelope: ErrorEnvelope = {
				error: {
					code,
					message: error.message,
					requestId,
					...(error.details !== undefined ? { details: error.details } : {}),
					...(isDev && error.stack ? { stack: error.stack } : {}),
				},
			};
			void reply.status(statusCode).send(envelope);
			return;
		}

		// 2. Fastify validation error (AJV)
		if ('validation' in error && error.validation) {
			const extraFields: string[] = [];
			if (Array.isArray(error.validation)) {
				for (const v of error.validation as Array<{
					keyword?: string;
					params?: { additionalProperty?: string };
				}>) {
					if (
						v.keyword === 'additionalProperties' &&
						typeof v.params?.additionalProperty === 'string'
					) {
						extraFields.push(v.params.additionalProperty);
					}
				}
			}

			const envelope: ErrorEnvelope = {
				error: {
					code: 'E_VALIDATION',
					message: error.message || 'Request validation failed.',
					requestId,
					details: {
						validation: error.validation as unknown as Record<string, unknown>,
						...(extraFields.length > 0 ? { extraFields } : {}),
					},
					...(isDev && error.stack ? { stack: error.stack } : {}),
				},
			};
			void reply.status(STATUS_BAD_REQUEST).send(envelope);
			return;
		}

		// 3. Native / unexpected error: original message and stack only logged to server log
		request.log.error(error);
		const envelope: ErrorEnvelope = {
			error: {
				code: 'E_INTERNAL',
				message: 'An internal server error occurred.',
				requestId,
				...(isDev && error.stack ? { stack: error.stack } : {}),
			},
		};
		void reply.status(STATUS_INTERNAL_ERROR).send(envelope);
	});

	instance.setNotFoundHandler((request, reply) => {
		const requestId =
			request.id || (request.headers['x-request-id'] as string | undefined) || 'unknown';
		const envelope: ErrorEnvelope = {
			error: {
				code: 'E_NOT_FOUND',
				message: `Route ${request.method} ${request.url} not found.`,
				requestId,
			},
		};
		void reply.status(STATUS_NOT_FOUND).send(envelope);
	});
}

export const errorHandlerPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	createErrorHandler(instance);
};

Object.defineProperty(errorHandlerPlugin, Symbol.for('skip-override'), {
	value: true,
	configurable: true,
});
