import type { FastifyInstance } from 'fastify';

export interface HealthDiagnostics {
	readonly ok: true;
	readonly uptimeSec: number;
	readonly rss: number;
	readonly eventIdRange: {
		readonly min: number | null;
		readonly max: number | null;
	};
	readonly activeRuns: number;
	readonly sseClients: number;
	readonly dbSizeBytes: number;
}

export function registerHealthRoute(instance: FastifyInstance): void {
	instance.get('/api/v1/health', async (request): Promise<HealthDiagnostics> => {
		const container = request.server.container;
		const memory = process.memoryUsage();
		const rss = memory.rss;

		let uptimeSec = Math.floor(process.uptime());
		if (container?.clock?.now && typeof container.startedAtMs === 'number') {
			const nowMs = Date.parse(container.clock.now());
			if (!Number.isNaN(nowMs) && nowMs >= container.startedAtMs) {
				uptimeSec = Math.floor((nowMs - container.startedAtMs) / 1000);
			}
		}

		let minId: number | null = null;
		let maxId: number | null = null;
		if (container?.events?.ringBuffer) {
			const oldest = container.events.ringBuffer.oldest();
			const latest = container.events.ringBuffer.latest();
			minId = oldest ? oldest.id : null;
			maxId = latest ? latest.id : null;
		}

		let dbSizeBytes = 0;
		if (container?.database) {
			try {
				const pageCount = Number(container.database.pragma('page_count', { simple: true }));
				const pageSize = Number(container.database.pragma('page_size', { simple: true }));
				if (Number.isFinite(pageCount) && Number.isFinite(pageSize)) {
					dbSizeBytes = pageCount * pageSize;
				}
			} catch {
				dbSizeBytes = 0;
			}
		}

		return {
			ok: true,
			uptimeSec,
			rss,
			eventIdRange: { min: minId, max: maxId },
			activeRuns: 0,
			sseClients: 0,
			dbSizeBytes,
		};
	});
}
