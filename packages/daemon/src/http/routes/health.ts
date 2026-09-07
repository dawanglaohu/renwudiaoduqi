import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(instance: FastifyInstance): void {
	instance.get('/api/v1/health', async () => {
		return { ok: true };
	});
}
