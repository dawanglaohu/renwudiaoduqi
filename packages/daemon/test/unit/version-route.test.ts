import { CURRENT_API_VERSION, type VersionResponse } from '@agent-scheduler/shared/api/system';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routesPlugin } from '../../src/http/plugins/50-routes.ts';
import { registerVersionRoute } from '../../src/http/routes/version.ts';

describe('GET /api/v1/version Route (M10-T4 R1, E-14)', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = fastify({ logger: false });
	});

	afterEach(async () => {
		await app.close();
	});

	it('registers directly and returns 200 with VersionResponse keys matching contract', async () => {
		registerVersionRoute(app);
		await app.ready();

		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/version',
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload) as VersionResponse;

		// Assert keys match VersionResponse: { daemon, apiVersion, node }
		expect(Object.keys(body).sort()).toEqual(['apiVersion', 'daemon', 'node']);
		expect(body.apiVersion).toBe(CURRENT_API_VERSION);
		expect(body.apiVersion).toBe('v1');
		expect(typeof body.daemon).toBe('string');
		expect(typeof body.node).toBe('string');
	});

	it('routesPlugin integrates GET /api/v1/version without falling back to not-implemented stub', async () => {
		// Mock minimal container for health check / routes registration
		app.decorate('container', {} as never);
		await app.register(routesPlugin, { prefix: '/api/v1' });
		await app.ready();

		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/version',
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);

		// Must NOT be the not-implemented 500 error envelope
		expect(body).not.toHaveProperty('error');
		expect(body.apiVersion).toBe(CURRENT_API_VERSION);
		expect(body.daemon).toBeDefined();
		expect(body.node).toBeDefined();
	});
});
