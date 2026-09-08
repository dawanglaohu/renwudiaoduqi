import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContainer } from '../boot/container.ts';
import { AppError } from '../errors/app-error.ts';
import { registerHealthRoute } from './routes/health.ts';

declare module 'fastify' {
	interface FastifyInstance {
		container: AppContainer;
	}
}

export interface HttpServer {
	readonly instance: FastifyInstance;
	listen(options: { readonly host: string; readonly port: number }): Promise<string>;
	close(): Promise<void>;
}

export function createHttpServer(deps: {
	readonly container: AppContainer;
}): HttpServer {
	const instance = Fastify({ logger: false, forceCloseConnections: true });
	instance.decorate('container', deps.container);
	registerHealthRoute(instance);
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
