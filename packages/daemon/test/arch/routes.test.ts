import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	REQUEST_BODY_SCHEMAS,
	ROUTES,
	type RouteDefinition,
} from '@agent-scheduler/shared/api/routes';
import { describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDir, '../../../..');

/**
 * The container's pairing bootstrap asserts POSIX 0600 on the pairing-code file
 * unless the host platform is win32, so the fixture must declare the platform it
 * actually runs on; hardcoding 'linux' made the whole container unusable on Windows.
 */
function hostPlatform(): 'win32' | 'darwin' | 'linux' {
	const platform = process.platform;
	return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

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

function makeTestContainer() {
	const dataDir = resolve(currentDir, '../fixtures');
	const lockAdapter = createMemoryLockAdapter();
	const db = openDatabase(':memory:');
	const migrationsDir = join(currentDir, '../../migrations');
	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-09T12:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: () => readdirSync(migrationsDir),
			readFile: (p: string) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDir);
	return createContainer({
		config: {
			port: 7817,
			bind: '127.0.0.1',
			dataDir,
			logLevel: 'error',
			dev: false,
		},
		database: db,
		hostInputs: { platform: hostPlatform(), homedir: dataDir },
		lockAdapter,
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock: { now: () => '2026-09-09T12:00:00.000Z' },
	});
}

describe('M2-T6 Route consistency, request validation, and contract assertions', () => {
	it('AC 1: Fastify registered method+path set === routes.ts constant table exactly (no more, no less)', async () => {
		const container = makeTestContainer();
		const server = createHttpServer({ container });

		const registeredRoutes: Array<{ method: string; url: string }> = [];
		server.instance.addHook('onRoute', (routeOptions) => {
			const methods = Array.isArray(routeOptions.method)
				? routeOptions.method
				: [routeOptions.method];
			for (const method of methods) {
				if (method !== 'HEAD' && method !== 'head') {
					registeredRoutes.push({
						method,
						url: routeOptions.url,
					});
				}
			}
		});

		await server.instance.ready();

		// `@fastify/static` (80-static.ts, wildcard: true, prefix: '/') registers the SPA
		// fallback `GET /*` whenever packages/web/dist exists — i.e. on every machine that
		// ran `vite build` first, which is exactly what CI does. It is a static file route,
		// not part of the API contract in routes.ts, so compare the contract surface only.
		const STATIC_FALLBACK_ROUTE = 'GET /*';
		const actualSet = new Set(
			registeredRoutes
				.map((r) => `${r.method.toUpperCase()} ${r.url}`)
				.filter((route) => route !== STATIC_FALLBACK_ROUTE),
		);
		const expectedSet = new Set(
			ROUTES.map((r: RouteDefinition) => `${r.method.toUpperCase()} ${r.path}`),
		);

		// Diff detection
		const missingInFastify = [...expectedSet].filter((x) => !actualSet.has(x));
		const extraInFastify = [...actualSet].filter((x) => !expectedSet.has(x));

		expect(
			missingInFastify,
			`Routes declared in routes.ts but missing in Fastify: ${missingInFastify.join(', ')}`,
		).toEqual([]);
		expect(
			extraInFastify,
			`Routes registered in Fastify but missing in routes.ts: ${extraInFastify.join(', ')}`,
		).toEqual([]);
		expect(actualSet.size).toBe(ROUTES.length);
		expect(actualSet).toEqual(expectedSet);
	});

	it('AC 2 & E-215: Key list constants are exhaustive for every request body interface', () => {
		// Every body-bearing route in the constant table must have exactly one registered
		// schema plus key list (and vice versa). The expected set comes from ROUTES rather
		// than a pinned total, so a new request body extends routes.ts only.
		const bodyBearingRoutes = ROUTES.filter((route) => route.bodySchema !== undefined).map(
			(route) => `${route.method} ${route.path}`,
		);
		const registeredBodyRoutes = REQUEST_BODY_SCHEMAS.map((item) => `${item.method} ${item.path}`);
		expect(new Set(registeredBodyRoutes).size).toBe(registeredBodyRoutes.length);
		expect(new Set(registeredBodyRoutes)).toEqual(new Set(bodyBearingRoutes));
		expect(bodyBearingRoutes.length).toBeGreaterThan(0);

		for (const item of REQUEST_BODY_SCHEMAS) {
			expect(
				item.keys.length,
				`Key list for ${item.name} should have at least one declared key`,
			).toBeGreaterThan(0);
			const uniqueKeys = new Set(item.keys);
			expect(uniqueKeys.size).toBe(item.keys.length);
		}

		// Verify compile-time type exhaustiveness check type helper logic
		type TestType = { a: string; b: number };
		type AssertExhaustive<T, K extends readonly (keyof T)[]> = [
			Exclude<keyof T, K[number]>,
		] extends [never]
			? true
			: never;

		const validKeys = ['a', 'b'] as const;
		type ValidCheck = AssertExhaustive<TestType, typeof validKeys>;
		const _valid: ValidCheck = true;
		expect(_valid).toBe(true);

		// Missing key produces 'never'
		const incompleteKeys = ['a'] as const;
		type IncompleteCheck = AssertExhaustive<TestType, typeof incompleteKeys>;
		type IsNever = [IncompleteCheck] extends [never] ? true : false;
		const _isNever: IsNever = true;
		expect(_isNever).toBe(true);
	});

	it('AC 3 & E-216: Contract test fails if JSON Schema properties drift from TS interface key list', () => {
		for (const item of REQUEST_BODY_SCHEMAS) {
			const schemaPropKeys = Object.keys(item.schema.properties ?? {}).sort();
			const declaredKeys = [...item.keys].sort();

			expect(
				schemaPropKeys,
				`Schema properties for ${item.name} must match declared TypeScript interface keys exactly`,
			).toEqual(declaredKeys);
		}

		// Verify negative case: if schema has an unmapped extra property, drift is detected
		const sampleSchema = {
			type: 'object',
			additionalProperties: false,
			properties: {
				code: { type: 'string' },
				deviceName: { type: 'string' },
				extraDriftProp: { type: 'string' },
			},
		};
		const sampleKeys = ['code', 'deviceName'];
		const sampleDiff = Object.keys(sampleSchema.properties).filter((k) => !sampleKeys.includes(k));
		expect(sampleDiff).toEqual(['extraDriftProp']);
	});

	it('AC 4 & E-217: All request body schemas have additionalProperties:false and return 400 with extra field names', async () => {
		// 1. Verify static schema constraint
		for (const item of REQUEST_BODY_SCHEMAS) {
			expect(
				item.schema.additionalProperties,
				`Schema ${item.name} must declare additionalProperties: false`,
			).toBe(false);
		}

		// 2. Verify runtime rejection on Fastify for all endpoints with a body
		const container = makeTestContainer();
		const server = createHttpServer({ container });
		await server.instance.ready();

		const claim = await container.services.pairing.claimPairingCode({
			code:
				container.services.pairing.getActivePairingCode()?.code ??
				container.services.pairing.createPairingCode().code,
			deviceName: 'test-device',
		});
		const authToken = `Bearer ${claim.token}`;

		const testPayloads: Record<string, Record<string, unknown>> = {
			'/api/v1/pair/claim': { code: 'test-code-123', deviceName: 'my-desktop' },
			'/api/v1/documents': { docsPath: '/absolute/path/docs-data.js' },
			'/api/v1/documents/:docId/settings': { laneCount: 3 },
			'/api/v1/batches/:batchId/start': { gateOverrides: { dispatch: 'manual' } },
			'/api/v1/agents/:agentId': { monogram: 'CD' },
			'/api/v1/runs': {
				taskId: 'M1-T1',
				agentId: 'codex',
				idempotencyKey: 'idemp-key-12345',
			},
			'/api/v1/runs/:runId/abort': { reason: 'manual stop' },
			'/api/v1/runs/:runId/rerun': { idempotencyKey: 'rerun-key-12345' },
			'/api/v1/runs/:runId/messages': { text: 'hello world', kind: 'reply' },
			'/api/v1/gates/:gateId/decide': { decision: 'pass' },
			'/api/v1/settings/gates': {
				dispatch: 'auto',
				review: 'auto',
				landing: 'manual',
			},
		};

		for (const item of REQUEST_BODY_SCHEMAS) {
			const resolvedPath = item.path
				.replace(':docId', 'doc-1')
				.replace(':batchId', 'batch-1')
				.replace(':agentId', 'codex')
				.replace(':runId', 'run-1')
				.replace(':gateId', 'gate-1');

			const basePayload = testPayloads[item.path] ?? {};
			const payloadWithExtra = {
				...basePayload,
				extraUnrecognizedField_e217: 'should_fail',
			};

			const response = await server.instance.inject({
				method: item.method,
				url: resolvedPath,
				payload: payloadWithExtra,
				headers: { authorization: authToken },
			});

			expect(
				response.statusCode,
				`Sending additional properties to ${item.method} ${resolvedPath} must return 400`,
			).toBe(400);

			const body = JSON.parse(response.body);
			expect(body.error).toBeDefined();
			expect(body.error.code).toBe('E_VALIDATION');

			// Verify that extra property name is explicitly listed in details
			const details = body.error.details ?? {};
			const extraFields = (details.extraFields as string[]) ?? [];
			const validation = JSON.stringify(details.validation ?? {});

			const containsExtraName =
				extraFields.includes('extraUnrecognizedField_e217') ||
				validation.includes('extraUnrecognizedField_e217');

			expect(
				containsExtraName,
				`Error details for ${item.path} must list the unrecognized field name 'extraUnrecognizedField_e217'`,
			).toBe(true);
		}
	}, 15000);

	it('AC 5: check-error-codes.mjs asserts consistency between codes.ts and 10 节 error table', () => {
		// Run the standalone verification script directly
		const scriptPath = join(repositoryRoot, 'scripts/check-error-codes.mjs');
		const result = execSync(`node "${scriptPath}"`, {
			cwd: repositoryRoot,
			encoding: 'utf8',
		});

		// Section 10 is the source of truth, so the expected total is read back from the
		// document instead of being pinned here: adding a code to the table must extend
		// codes.ts and the script's count, not require editing this assertion.
		const documentedCodes = [
			...readFileSync(
				join(repositoryRoot, 'docs/Agent任务调度器-开发文档/02-设计/10-接口约定.md'),
				'utf8',
			).matchAll(/^\|\s*`(E_[A-Z0-9_]+)`\s*\|\s*(?:server|client)\s*\|/gm),
		].map((match) => match[1]);
		expect(documentedCodes.length).toBeGreaterThan(0);

		const reported = /OK: (\d+) error codes match perfectly/.exec(result);
		expect(reported?.[1], `Unexpected script output: ${result}`).toBe(
			String(documentedCodes.length),
		);

		// The projection gate only bites when it is part of the workspace check.
		const workspaceCheck = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
			.scripts.check as string;
		expect(workspaceCheck).toContain('scripts/check-error-codes.mjs');
	});
});
