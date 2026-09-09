import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorCode } from '@agent-scheduler/shared/errors/codes';
import { describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { getHttpStatusForErrorCode } from '../../src/errors/http-status.ts';
import { LOG_REDACT_PATHS } from '../../src/http/plugins/10-logging.ts';
import { AUTH_WHITELIST, AUTH_WHITELIST_PATHS } from '../../src/http/plugins/30-auth.ts';
import { HTTP_PLUGIN_SEQUENCE, createHttpServer } from '../../src/http/server.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const daemonSrcDir = resolve(currentDir, '../../src');
const pluginsDir = join(daemonSrcDir, 'http/plugins');

function createMemoryLockAdapter(): NativeLockAdapter {
	let lockContents: string | undefined;
	const missing = (): NativeLockFailure => ({
		kind: 'not-found',
		error: new AppError('E_INTERNAL', 'Memory lock is missing.'),
	});
	return Object.freeze({
		platform: 'linux',
		filePath: '/machine/daemon.lock',
		dirPath: '/machine',
		reclaimPath: '/machine/daemon.lock.reclaim',
		permissionLines: ['root:root 0600'],
		createExclusive(contents: string): NativeLockWriteResult {
			if (lockContents !== undefined) {
				return {
					ok: false,
					failure: {
						kind: 'already-exists',
						error: new AppError('E_INTERNAL', 'Memory lock already exists.'),
					},
				};
			}
			lockContents = contents;
			return { ok: true };
		},
		read(): NativeLockReadResult {
			return lockContents === undefined
				? { ok: false, failure: missing() }
				: { ok: true, contents: lockContents };
		},
		remove(): NativeLockWriteResult {
			lockContents = undefined;
			return { ok: true };
		},
		verifyPermissions: (): NativeLockWriteResult => ({ ok: true }),
		inspectPermissions: (): NativeLockReadResult => ({
			ok: true,
			contents: 'root:root mode=600',
		}),
		createReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
		readReclaimGuard(): NativeLockReadResult {
			return { ok: false, failure: missing() };
		},
		removeReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
	});
}

function makeTestContainer(options: { readonly dev?: boolean } = {}) {
	const dataDir = resolve(currentDir, '../fixtures');
	const lockAdapter = createMemoryLockAdapter();
	return createContainer({
		config: {
			port: 7817,
			bind: '127.0.0.1',
			dataDir,
			logLevel: 'error',
			dev: options.dev ?? false,
		},
		database: {
			pragma: () => 4096,
			prepare: () => ({ get: () => ({}), all: () => [], run: () => ({ changes: 0 }) }),
			close: () => undefined,
		} as unknown as DatabaseConnection,
		hostInputs: { platform: 'linux', homedir: dataDir },
		lockAdapter,
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock: { now: () => '2026-09-09T12:00:00.000Z' },
	});
}

describe('M2-T1 HTTP Pipeline & Error Handling', () => {
	it('AC 1: registers plugins in the strict numerical order (00 -> 90)', () => {
		const expectedOrder = [
			'00-request-id',
			'10-logging',
			'20-security-headers',
			'30-auth',
			'40-ratelimit',
			'50-routes',
			'80-static',
			'90-error-handler',
		];
		expect(HTTP_PLUGIN_SEQUENCE).toEqual(expectedOrder);

		const pluginFiles = readdirSync(pluginsDir)
			.filter((file) => file.endsWith('.ts'))
			.sort();

		expect(pluginFiles.map((file) => file.replace(/\.ts$/, ''))).toEqual(expectedOrder);

		const container = makeTestContainer();
		const server = createHttpServer({ container });
		expect(server.instance.registeredPlugins).toEqual(expectedOrder);
	});

	it('AC 1: attaches request-id header and security headers to every response', async () => {
		const container = makeTestContainer();
		const server = createHttpServer({ container });

		const response = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/health',
			headers: { 'x-request-id': 'req_custom_12345' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['x-request-id']).toBe('req_custom_12345');
		expect(response.headers['x-content-type-options']).toBe('nosniff');
		expect(response.headers['x-frame-options']).toBe('DENY');
		expect(response.headers['referrer-policy']).toBe('no-referrer');
		expect(response.headers['content-security-policy']).toBe("default-src 'self'");
	});

	it('AC 1: maintains the exact three whitelisted endpoints in 30-auth', () => {
		expect(AUTH_WHITELIST).toEqual(['/health', '/pair/claim', '/version']);
		expect(AUTH_WHITELIST_PATHS).toEqual([
			'/api/v1/health',
			'/api/v1/pair/claim',
			'/api/v1/version',
		]);
	});

	it('AC 2: 90-error-handler is the only file with HTTP status literals across daemon http layer', () => {
		const filesToCheck = [
			join(daemonSrcDir, 'http/server.ts'),
			join(daemonSrcDir, 'http/routes/health.ts'),
			join(daemonSrcDir, 'http/routes/system.ts'),
			join(daemonSrcDir, 'errors/app-error.ts'),
			join(daemonSrcDir, 'errors/http-status.ts'),
			...readdirSync(pluginsDir)
				.filter((file) => file.endsWith('.ts') && !file.startsWith('90-'))
				.map((file) => join(pluginsDir, file)),
		];

		const httpStatusPattern =
			/\b(?:200|201|204|400|401|403|404|409|410|422|429|500|501|503|504|507)\b/;

		for (const file of filesToCheck) {
			const content = readFileSync(file, 'utf8');
			const match = httpStatusPattern.exec(content);
			expect(
				match,
				`File ${file} should not contain hardcoded HTTP status code: ${match?.[0]}`,
			).toBeNull();
		}
	});

	it('AC 2: maps unregistered error codes and non-AppErrors to 500 E_INTERNAL and hides internal message', async () => {
		const container = makeTestContainer({ dev: false });
		const server = createHttpServer({ container });

		server.instance.get('/api/v1/test/unregistered-code', async () => {
			throw new AppError(
				'E_CUSTOM_UNKNOWN' as unknown as ErrorCode,
				'This internal message must not leak.',
			);
		});

		server.instance.get('/api/v1/test/non-app-error', async () => {
			throw new Error('Database connection crashed on sensitive host!');
		});

		const res1 = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/test/unregistered-code',
		});
		expect(res1.statusCode).toBe(500);
		const body1 = res1.json();
		expect(body1).toMatchObject({
			error: {
				code: 'E_INTERNAL',
				message: 'An internal server error occurred.',
			},
		});
		expect(body1.error.message).not.toContain('This internal message must not leak');
		expect(body1.error.stack).toBeUndefined();

		const res2 = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/test/non-app-error',
		});
		expect(res2.statusCode).toBe(500);
		const body2 = res2.json();
		expect(body2).toMatchObject({
			error: {
				code: 'E_INTERNAL',
				message: 'An internal server error occurred.',
			},
		});
		expect(body2.error.message).not.toContain('Database connection crashed');
		expect(body2.error.stack).toBeUndefined();
	});

	it('AC 2: attaches stack trace to error envelope when AGSCHED_DEV is enabled', async () => {
		const container = makeTestContainer({ dev: true });
		const server = createHttpServer({ container });

		server.instance.get('/api/v1/test/error-with-stack', async () => {
			throw new Error('Dev failure message');
		});

		const response = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/test/error-with-stack',
		});
		expect(response.statusCode).toBe(500);
		const body = response.json();
		expect(body.error.code).toBe('E_INTERNAL');
		expect(typeof body.error.stack).toBe('string');
		expect(body.error.stack).toContain('Dev failure message');
	});

	it('AC 2: returns 404 E_NOT_FOUND for non-existent routes', async () => {
		const container = makeTestContainer();
		const server = createHttpServer({ container });

		const response = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/non-existent-route',
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toMatchObject({
			error: {
				code: 'E_NOT_FOUND',
				message: expect.stringContaining('not found'),
			},
		});
	});

	it('AC 3: logger redact covers authorization, *.token, *.pairingCode, *.deviceToken', () => {
		const requiredRedacts = ['authorization', '*.token', '*.pairingCode', '*.deviceToken'];
		for (const field of requiredRedacts) {
			expect(LOG_REDACT_PATHS).toContain(field);
		}
	});

	it('AC 4: does not register or import @fastify/cors anywhere in daemon src', () => {
		function scanDir(dir: string): string[] {
			const files: string[] = [];
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) files.push(...scanDir(fullPath));
				else if (entry.name.endsWith('.ts')) files.push(fullPath);
			}
			return files;
		}

		const allSrcFiles = scanDir(daemonSrcDir);
		for (const file of allSrcFiles) {
			const content = readFileSync(file, 'utf8');
			expect(content).not.toContain('@fastify/cors');
		}
	});

	it('AC 5 & E-195: error envelope details carries structured information for unrecognised version', async () => {
		const container = makeTestContainer();
		const server = createHttpServer({ container });

		server.instance.get('/api/v1/test/probe-unrecognized', async () => {
			throw new AppError(
				'E_AGENT_VERSION_UNRECOGNIZED',
				"Probe output did not match any known fingerprint for agent 'grok'.",
				{
					details: {
						observed: 'grok-cli 1.1.7',
						expected: '^grok \\d+\\.\\d+\\.\\d+',
						execPath: 'C:/Users/admin/AppData/Roaming/npm/grok.cmd',
					},
				},
			);
		});

		const response = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/test/probe-unrecognized',
		});

		expect(response.statusCode).toBe(409);
		const json = response.json();
		expect(json).toEqual({
			error: {
				code: 'E_AGENT_VERSION_UNRECOGNIZED',
				message: "Probe output did not match any known fingerprint for agent 'grok'.",
				requestId: expect.stringMatching(/^req_/),
				details: {
					observed: 'grok-cli 1.1.7',
					expected: '^grok \\d+\\.\\d+\\.\\d+',
					execPath: 'C:/Users/admin/AppData/Roaming/npm/grok.cmd',
				},
			},
		});
	});

	it('health route returns all seven Section 10 diagnostic fields', async () => {
		const container = makeTestContainer();
		const server = createHttpServer({ container });

		const response = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/health',
		});

		expect(response.statusCode).toBe(200);
		const data = response.json();
		expect(data).toHaveProperty('ok', true);
		expect(typeof data.uptimeSec).toBe('number');
		expect(typeof data.rss).toBe('number');
		expect(data.eventIdRange).toEqual({ min: null, max: null });
		expect(data.activeRuns).toBe(0);
		expect(data.sseClients).toBe(0);
		expect(typeof data.dbSizeBytes).toBe('number');
	});

	it('errors/http-status helper resolves status codes without hardcoded duplicate tables', () => {
		expect(getHttpStatusForErrorCode('E_VALIDATION')).toBe(400);
		expect(getHttpStatusForErrorCode('E_UNAUTHORIZED')).toBe(401);
		expect(getHttpStatusForErrorCode('E_FORBIDDEN')).toBe(403);
		expect(getHttpStatusForErrorCode('E_NOT_FOUND')).toBe(404);
		expect(getHttpStatusForErrorCode('E_AGENT_VERSION_UNRECOGNIZED')).toBe(409);
		expect(getHttpStatusForErrorCode('E_RATE_LIMITED')).toBe(429);
		expect(getHttpStatusForErrorCode('E_NETWORK')).toBeNull();
		expect(getHttpStatusForErrorCode('NON_EXISTENT_CODE')).toBeNull();
	});
});
