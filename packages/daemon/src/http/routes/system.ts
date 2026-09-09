import type { FastifyInstance } from 'fastify';

/** `GET /api/v1/system/usage` → `{dataDirBytes, byRun[], warnThreshold}` (10-接口约定 端点总表). */
export function registerSystemRoutes(instance: FastifyInstance): void {
	instance.get('/api/v1/system/usage', async (request) => {
		const usage = await request.server.container.services.system.getUsage();
		return {
			dataDirBytes: usage.dataDirBytes,
			byRun: usage.byRun.map((item) => ({ runId: item.runId, bytes: item.bytes })),
			warnThreshold: usage.warnThreshold,
		};
	});
}
