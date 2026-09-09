import type { FastifyInstance } from 'fastify';

/**
 * System routes: GET /api/v1/system/usage
 * 10-接口约定.md: returns { dataDirBytes, byRun[], warnThreshold }
 */
export function registerSystemRoutes(instance: FastifyInstance): void {
	instance.get('/api/v1/system/usage', async (request, reply) => {
		const systemService = request.server.container.services?.system;
		if (!systemService) {
			return reply.status(500).send({
				error: {
					code: 'E_INTERNAL',
					message: 'SystemService is not configured in container.',
					requestId: request.id,
				},
			});
		}

		const usage = await systemService.getUsage();
		return {
			dataDirBytes: usage.dataDirBytes,
			byRun: usage.byRun.map((item) => ({
				runId: item.runId,
				bytes: item.bytes,
			})),
			warnThreshold: usage.warnThreshold,
			freeBytes: usage.freeBytes,
		};
	});
}
