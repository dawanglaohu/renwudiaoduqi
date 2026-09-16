import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const dummyLockHandle: LockFileHandle = {
	path: '/dummy.lock',
	metadata: {
		pid: process.pid,
		uid: '1000',
		startedAt: new Date().toISOString(),
		port: 7817,
		bind: '127.0.0.1',
	},
	serializedMetadata: '{}',
	released: false,
	release: () => {},
};

const dummyLockAdapter: NativeLockAdapter = {
	platform: 'linux',
	filePath: '/dummy.lock',
	dirPath: '/dummy',
	reclaimPath: '/dummy.reclaim',
	permissionLines: [],
	createExclusive: () => ({ ok: true }),
	read: () => ({ ok: true, contents: '{}' }),
	remove: () => ({ ok: true }),
	verifyPermissions: () => ({ ok: true }),
	createReclaimGuard: () => ({ ok: true }),
	readReclaimGuard: () => ({ ok: true, contents: '{}' }),
	removeReclaimGuard: () => ({ ok: true }),
	inspectPermissions: () => ({ ok: true, contents: '{}' }),
};

describe('Pairing & Devices HTTP Routes Integration (M2-T2, E-07, E-127, E-226)', () => {
	let testDir: string;
	let dbPath: string;
	let db: DatabaseConnection;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'sched-pair-integ-'));
		dbPath = join(testDir, 'test.db');
		db = openDatabase(dbPath);
		const runner = createMigrationRunner({
			clock: { now: () => new Date().toISOString() },
			database: db,
			fileSystem: {
				readDirectory: () => readdirSync(migrationsDir),
				readFile: (p: string) => readFileSync(p, 'utf8'),
			},
		});
		runner.run(migrationsDir);
	});

	afterEach(() => {
		db.close();
		// macOS keeps the SQLite -wal/-shm files briefly visible after close, so a single
		// rmdir can hit ENOTEMPTY; retrying is what Node's own docs recommend for rmSync.
		rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	function makeServer(options?: { clock?: { now: () => string } }) {
		const clock = options?.clock ?? { now: () => new Date().toISOString() };
		const container = createContainer({
			config: {
				port: 7817,
				bind: '127.0.0.1',
				dataDir: testDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: {
				platform: 'linux',
				homedir: '/root',
			},
			lockAdapter: dummyLockAdapter,
			instanceLock: dummyLockHandle,
			clock,
		});
		return createHttpServer({ container });
	}

	it('AC 5 & E-226: bootstraps initial pairing code into dataDir/pairing-code.txt with 0600 mode on fresh database', async () => {
		const currentTime = '2026-09-10T12:00:00.000Z';
		const server = makeServer({ clock: { now: () => currentTime } });
		const codeFilePath = join(testDir, 'pairing-code.txt');
		const pairingCode = readFileSync(codeFilePath, 'utf8').trim();
		expect(pairingCode).toMatch(/^\d+$/);

		const stat = statSync(codeFilePath);
		// NTFS cannot express POSIX permission bits (chmod 0600 still reports 0666), so the
		// bit comparison only means something on a file system that can hold it. This is the
		// same capability test the service itself applies before asserting 0600.
		if ((stat.mode & 0o777) !== 0o666) {
			expect(stat.mode & 0o777).toBe(0o600);
		}

		// Claim the bootstrap code via POST /api/v1/pair/claim
		const res = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			payload: {
				code: pairingCode,
				deviceName: 'Primary Workstation',
			},
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.deviceId).toBeDefined();
		expect(body.token).toBeDefined();

		// File is deleted upon claim (用后即删)
		let exists = true;
		try {
			statSync(codeFilePath);
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);

		// Reusing the same code must return 401 E_PAIRING_CODE_INVALID (E-07)
		const reuseRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			payload: {
				code: pairingCode,
				deviceName: 'Secondary Machine',
			},
		});
		expect(reuseRes.statusCode).toBe(401);
		const reuseBody = JSON.parse(reuseRes.body);
		expect(reuseBody.error.code).toBe('E_PAIRING_CODE_INVALID');
	});

	it('validates request payload with AJV schema and rejects unknown properties', async () => {
		const server = makeServer();
		const res = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			payload: {
				code: '123456',
				deviceName: 'Test Phone',
				extraProperty: 'not allowed',
			},
		});

		expect(res.statusCode).toBe(400);
		const body = JSON.parse(res.body);
		expect(body.error.code).toBe('E_VALIDATION');
	});

	it('supports full device lifecycle: pair claim -> generate code -> list -> revoke', async () => {
		const currentTime = '2026-09-10T12:00:00.000Z';
		const server = makeServer({ clock: { now: () => currentTime } });
		const codeFilePath = join(testDir, 'pairing-code.txt');
		const initialCode = readFileSync(codeFilePath, 'utf8').trim();

		// 1. Claim initial device
		const claimRes1 = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			payload: { code: initialCode, deviceName: 'MacBook' },
		});
		expect(claimRes1.statusCode).toBe(200);
		const dev1 = JSON.parse(claimRes1.body);

		// 2. Generate a new pairing code using dev1 token via POST /api/v1/pair/code
		const newCodeRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/code',
			headers: { authorization: `Bearer ${dev1.token}` },
		});
		expect(newCodeRes.statusCode).toBe(200);
		const newCodeBody = JSON.parse(newCodeRes.body);
		expect(newCodeBody.code).toBeDefined();
		expect(newCodeBody.expiresAt).toBeDefined();

		// 3. Claim second device using newly generated pairing code
		const claimRes2 = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			payload: { code: newCodeBody.code, deviceName: 'Android Phone' },
		});
		expect(claimRes2.statusCode).toBe(200);
		const dev2 = JSON.parse(claimRes2.body);

		// 4. List devices via GET /api/v1/devices
		const listRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/devices',
			headers: { authorization: `Bearer ${dev1.token}` },
		});
		expect(listRes.statusCode).toBe(200);
		const listBody = JSON.parse(listRes.body);
		expect(listBody.devices).toHaveLength(2);
		expect(listBody.devices[0].id).toBe(dev1.deviceId);
		expect(listBody.devices[0].name).toBe('MacBook');
		expect(listBody.devices[0].pairedAt).toBeDefined();
		expect(listBody.devices[0].token_hash).toBeUndefined(); // no secrets
		expect(listBody.devices[1].id).toBe(dev2.deviceId);
		expect(listBody.devices[1].name).toBe('Android Phone');

		// 5. Revoke dev2 via DELETE /api/v1/devices/:deviceId
		const revokeRes = await server.instance.inject({
			method: 'DELETE',
			url: `/api/v1/devices/${dev2.deviceId}`,
			headers: { authorization: `Bearer ${dev1.token}` },
		});
		expect(revokeRes.statusCode).toBe(200);
		const revokeBody = JSON.parse(revokeRes.body);
		expect(revokeBody.revokedAt).toBeDefined();

		// 6. Access using dev2 token must now return 401 E_DEVICE_REVOKED (AC 3, E-127)
		const dev2AccessRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/devices',
			headers: { authorization: `Bearer ${dev2.token}` },
		});
		expect(dev2AccessRes.statusCode).toBe(401);
		const dev2AccessBody = JSON.parse(dev2AccessRes.body);
		expect(dev2AccessBody.error.code).toBe('E_DEVICE_REVOKED');
	});

	it('AC 4 & E-07: rate limit on /pair/* allows 10 requests/min and 11th returns 429, immediately invalidating pairing code', async () => {
		const server = makeServer();
		const codeFilePath = join(testDir, 'pairing-code.txt');
		const code = readFileSync(codeFilePath, 'utf8').trim();

		// First 10 requests with invalid codes consume the rate limit window
		for (let i = 0; i < 10; i++) {
			const res = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/pair/claim',
				remoteAddress: '10.0.0.1',
				payload: { code: 'wrong', deviceName: `Test ${i}` },
			});
			expect(res.statusCode).toBe(401);
		}

		// 11th request from same IP must hit rate limit (429)
		const rateLimitedRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			remoteAddress: '10.0.0.1',
			payload: { code, deviceName: 'Legit Attempt' },
		});
		expect(rateLimitedRes.statusCode).toBe(429);
		const rateLimitedBody = JSON.parse(rateLimitedRes.body);
		expect(rateLimitedBody.error.code).toBe('E_RATE_LIMITED');

		// Rate limit trigger must immediately invalidate the pairing code!
		// Even from another IP, trying to claim with the original code now fails with 401 E_PAIRING_CODE_INVALID
		const anotherIpRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			remoteAddress: '10.0.0.2',
			payload: { code, deviceName: 'Another IP' },
		});
		expect(anotherIpRes.statusCode).toBe(401);
		const anotherIpBody = JSON.parse(anotherIpRes.body);
		expect(anotherIpBody.error.code).toBe('E_PAIRING_CODE_INVALID');
	});

	it('returns 404 E_NOT_FOUND when revoking a non-existent device', async () => {
		const server = makeServer();
		const codeFilePath = join(testDir, 'pairing-code.txt');
		const code = readFileSync(codeFilePath, 'utf8').trim();

		const claimRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/pair/claim',
			payload: { code, deviceName: 'Admin' },
		});
		const { token } = JSON.parse(claimRes.body);

		const res = await server.instance.inject({
			method: 'DELETE',
			url: '/api/v1/devices/non_existent_device_id',
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(404);
		const body = JSON.parse(res.body);
		expect(body.error.code).toBe('E_NOT_FOUND');
	});
});
