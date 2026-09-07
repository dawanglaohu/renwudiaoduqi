import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseConnection } from '../db/open-database.ts';
import type { ProcessConfig } from '../config/env.ts';
import { registerHealthRoute } from './routes/health.ts';

export interface HttpServer {
	readonly instance: FastifyInstance;
	listen(options: { readonly host: string; readonly port: number }): Promise<string>;
	close(): Promise<void>;
}

export function createHttpServer(deps: {
	readonly database: DatabaseConnection;
	readonly config: ProcessConfig;
}): HttpServer {
	const instance = Fastify({ logger: false });
	registerHealthRoute(instance);
	return Object.freeze({
		instance,
		listen(options: { readonly host: string; readonly port: number }): Promise<string> {
			return instance.listen(options);
		},
		close(): Promise<void> {
			return instance.close();
		},
	});
}
