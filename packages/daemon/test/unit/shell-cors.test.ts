import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { securityHeadersPlugin } from '../../src/http/plugins/20-security-headers.ts';

describe('desktop shell cross-origin requests', () => {
	it('answers the native WebView preflight and exposes authenticated responses', async () => {
		const app = Fastify();
		await app.register(securityHeadersPlugin);
		app.get('/api/v1/snapshot', async () => ({ tasks: [] }));
		try {
			const origin = 'http://tauri.localhost';
			const preflight = await app.inject({
				method: 'OPTIONS',
				url: '/api/v1/snapshot',
				headers: {
					origin,
					'access-control-request-method': 'GET',
					'access-control-request-headers': 'authorization,content-type',
				},
			});
			expect(preflight.statusCode).toBe(200);
			expect(preflight.headers['access-control-allow-origin']).toBe(origin);
			expect(preflight.headers['access-control-allow-headers']).toBe('authorization,content-type');

			const snapshot = await app.inject({
				method: 'GET',
				url: '/api/v1/snapshot',
				headers: { origin },
			});
			expect(snapshot.statusCode).toBe(200);
			expect(snapshot.headers['access-control-allow-origin']).toBe(origin);
		} finally {
			await app.close();
		}
	});

	it('does not grant CORS access to a web origin', async () => {
		const app = Fastify();
		await app.register(securityHeadersPlugin);
		app.get('/api/v1/snapshot', async () => ({ tasks: [] }));
		try {
			const response = await app.inject({
				method: 'GET',
				url: '/api/v1/snapshot',
				headers: { origin: 'https://example.invalid' },
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
		} finally {
			await app.close();
		}
	});
});
