import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/app-error.ts';

export interface RateLimitOptions {
	readonly windowMs?: number;
	readonly maxRequests?: number;
}

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_REQUESTS = 10;

export function createMemorySlidingWindowRateLimiter(options: RateLimitOptions = {}) {
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
	const hitTimestampsByIp = new Map<string, number[]>();

	return {
		checkAndRecord(ip: string, now: number): boolean {
			const existing = hitTimestampsByIp.get(ip) ?? [];
			const threshold = now - windowMs;
			const valid = existing.filter((timestamp) => timestamp > threshold);
			if (valid.length >= maxRequests) {
				hitTimestampsByIp.set(ip, valid);
				return false;
			}
			valid.push(now);
			hitTimestampsByIp.set(ip, valid);
			return true;
		},
		reset(): void {
			hitTimestampsByIp.clear();
		},
	};
}

export const ratelimitPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	const limiter = createMemorySlidingWindowRateLimiter();

	instance.addHook('onRequest', async (request) => {
		const pathname = request.url.split('?')[0] ?? '';
		const isPairRoute =
			pathname === '/pair' || pathname.startsWith('/pair/') || pathname.includes('/pair/');
		if (!isPairRoute) {
			return;
		}

		const ip = request.ip || '127.0.0.1';
		const allowed = limiter.checkAndRecord(ip, Date.now());
		if (!allowed) {
			// TODO(M2-T3): Revoke the current pairing code via pairService before throwing 429
			throw new AppError('E_RATE_LIMITED', 'Rate limit exceeded for pairing endpoint.', {
				details: { ip, windowMs: DEFAULT_WINDOW_MS, maxRequests: DEFAULT_MAX_REQUESTS },
			});
		}
	});
};
