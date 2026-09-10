import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContainer } from '../boot/container.ts';
import { AppError } from '../errors/app-error.ts';
import { requestIdPlugin } from './plugins/00-request-id.ts';
import { LOG_REDACT_PATHS, loggingPlugin } from './plugins/10-logging.ts';
import { securityHeadersPlugin } from './plugins/20-security-headers.ts';
import { authPlugin } from './plugins/30-auth.ts';
import { ratelimitPlugin } from './plugins/40-ratelimit.ts';
import { routesPlugin } from './plugins/50-routes.ts';
import { staticPlugin } from './plugins/80-static.ts';
import { createErrorHandler, errorHandlerPlugin } from './plugins/90-error-handler.ts';

declare module 'fastify' {
	interface FastifyInstance {
		container: AppContainer;
		registeredPlugins: readonly string[];
	}
}

export const HTTP_PLUGIN_SEQUENCE = Object.freeze([
	'00-request-id',
	'10-logging',
	'20-security-headers',
	'30-auth',
	'40-ratelimit',
	'50-routes',
	'80-static',
	'90-error-handler',
] as const);

export interface HttpServer {
	readonly instance: FastifyInstance;
	listen(options: { readonly host: string; readonly port: number }): Promise<string>;
	close(): Promise<void>;
}

export function createHttpServer(deps: {
	readonly container: AppContainer;
}): HttpServer {
	const instance = Fastify({
		ajv: {
			customOptions: {
				removeAdditional: false,
			},
		},
		logger: {
			level: deps.container.config.logLevel,
			redact: [...LOG_REDACT_PATHS],
		},
		ajv: {
			customOptions: {
				removeAdditional: false,
				allErrors: true,
			},
		},
		forceCloseConnections: true,
	});
	instance.decorate('container', deps.container);
	instance.decorate('registeredPlugins', HTTP_PLUGIN_SEQUENCE);

	// Plugin chain registered in strict numerical sequence:
	// 00-request-id → 10-logging → 20-security-headers → 30-auth → 40-ratelimit → 50-routes → 80-static → 90-error-handler
	void instance.register(requestIdPlugin);
	void instance.register(loggingPlugin);
	void instance.register(securityHeadersPlugin);
	void instance.register(
		async (apiScope) => {
			void apiScope.register(authPlugin);
			void apiScope.register(ratelimitPlugin);
			void apiScope.register(routesPlugin);
			createErrorHandler(apiScope);
		},
		{ prefix: '/api/v1' },
	);
	void instance.register(staticPlugin);
	void instance.register(errorHandlerPlugin);

	return Object.freeze({
		instance,
		async listen(options: { readonly host: string; readonly port: number }): Promise<string> {
			try {
				return await instance.listen(options);
			} catch (cause) {
				const nativeCode = getErrorCode(cause);
				throw new AppError(
					'E_INTERNAL',
					nativeCode === 'EADDRINUSE'
						? 'The configured daemon address is already in use.'
						: 'The daemon HTTP server failed to listen.',
					{
						cause,
						details: { host: options.host, port: options.port, nativeCode },
					},
				);
			}
		},
		close(): Promise<void> {
			return instance.close();
		},
	});
}

function getErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}
