import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createDevicesRepo } from '../../src/repo/devices.ts';
import {
	type PairingFileSystem,
	buildWindowsDaclCommand,
	createPairingService,
} from '../../src/service/pairing.ts';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

function createTestDb(dbPath: string): DatabaseConnection {
	const db = openDatabase(dbPath);
	const runner = createMigrationRunner({
		clock: { now: () => new Date().toISOString() },
		database: db,
		fileSystem: {
			readDirectory: () => ['0001_init.sql'],
			readFile: (p: string) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDir);
	return db;
}

describe('M2-T2 devices repo & pairing service', () => {
	const dbPath = join(dirname(fileURLToPath(import.meta.url)), 'test-devices.db');
	let db: DatabaseConnection;

	beforeEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore
		}
		db = createTestDb(dbPath);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
			unlinkSync(`${dbPath}-wal`);
			unlinkSync(`${dbPath}-shm`);
		} catch {
			// ignore
		}
	});

	describe('DevicesRepo CRUD', () => {
		it('inserts and retrieves a device by id and lists devices', () => {
			const repo = createDevicesRepo(db);
			expect(repo.countTotal()).toBe(0);
			expect(repo.countActive()).toBe(0);

			repo.insert({
				id: 'dev_1',
				name: 'MacBook Pro',
				token_hash: 'hash123',
				token_salt: 'salt123',
				paired_at: '2026-09-10T00:00:00.000Z',
				last_seen_at: '2026-09-10T00:00:00.000Z',
				revoked_at: null,
			});

			expect(repo.countTotal()).toBe(1);
			expect(repo.countActive()).toBe(1);

			const found = repo.findById('dev_1');
			expect(found).toEqual({
				id: 'dev_1',
				name: 'MacBook Pro',
				token_hash: 'hash123',
				token_salt: 'salt123',
				paired_at: '2026-09-10T00:00:00.000Z',
				last_seen_at: '2026-09-10T00:00:00.000Z',
				revoked_at: null,
			});

			const list = repo.list();
			expect(list).toHaveLength(1);
			expect(list[0]?.id).toBe('dev_1');

			const activeList = repo.listActive();
			expect(activeList).toHaveLength(1);
		});

		it('updates last_seen_at and revokes a device', () => {
			const repo = createDevicesRepo(db);
			repo.insert({
				id: 'dev_2',
				name: 'iPhone 16',
				token_hash: 'hash456',
				token_salt: 'salt456',
				paired_at: '2026-09-10T00:00:00.000Z',
				last_seen_at: '2026-09-10T00:00:00.000Z',
			});

			expect(repo.updateLastSeen('dev_2', '2026-09-10T00:05:00.000Z')).toBe(true);
			expect(repo.findById('dev_2')?.last_seen_at).toBe('2026-09-10T00:05:00.000Z');

			expect(repo.revoke('dev_2', '2026-09-10T00:10:00.000Z')).toBe(true);
			// Idempotent: second revoke returns false because revoked_at IS NOT NULL
			expect(repo.revoke('dev_2', '2026-09-10T00:11:00.000Z')).toBe(false);

			expect(repo.countTotal()).toBe(1);
			expect(repo.countActive()).toBe(0);
			expect(repo.listActive()).toHaveLength(0);
			expect(repo.findById('dev_2')?.revoked_at).toBe('2026-09-10T00:10:00.000Z');
		});

		it('returns null for non-existent device and throws validation on empty revoke', () => {
			const repo = createDevicesRepo(db);
			expect(repo.findById('non-existent')).toBeNull();
			expect(() => repo.revoke('', '2026-09-10T00:00:00.000Z')).toThrow(AppError);
		});
	});

	describe('PairingService logic and boundary tests', () => {
		let mockTime = '2026-09-10T12:00:00.000Z';
		const mockClock = { now: () => mockTime };
		let idSeq = 1;
		const mockIds = { newId: () => `dev_id_${idSeq++}` };

		it('AC 1 & E-07: pairing code is one-time, TTL <= 60s, in-memory, expires or consumes', async () => {
			const repo = createDevicesRepo(db);
			const service = createPairingService({
				devicesRepo: repo,
				clock: mockClock,
				ids: mockIds,
				dataDir: '/fake/data',
			});

			// Create pairing code (max 60s)
			const { code, expiresAt } = service.createPairingCode(60);
			expect(code).toBeDefined();
			expect(typeof code).toBe('string');
			expect(new Date(expiresAt).getTime()).toBe(new Date(mockTime).getTime() + 60000);
			expect(service.getActivePairingCode()?.code).toBe(code);

			// Claim with correct code
			const claimResult = await service.claimPairingCode({
				code,
				deviceName: 'Test Phone',
			});
			expect(claimResult.deviceId).toBeDefined();
			expect(claimResult.token).toBeDefined();

			// One-time: code is now gone from memory
			expect(service.getActivePairingCode()).toBeNull();

			// Second claim with the same code must fail (E-07)
			await expect(
				service.claimPairingCode({ code, deviceName: 'Another Phone' }),
			).rejects.toMatchObject({
				code: 'E_PAIRING_CODE_INVALID',
			});

			// Create another code and test expiration (TTL <= 60s)
			const second = service.createPairingCode(30);
			// Advance time past 30 seconds
			mockTime = new Date(new Date(mockTime).getTime() + 31000).toISOString();

			// Expired code must fail (E-07)
			await expect(
				service.claimPairingCode({
					code: second.code,
					deviceName: 'Late Phone',
				}),
			).rejects.toMatchObject({
				code: 'E_PAIRING_CODE_INVALID',
			});
			expect(service.getActivePairingCode()).toBeNull();
		});

		it('AC 2: token is stored only as scrypt hash + salt in DB; no plaintext token exists in DB', async () => {
			const repo = createDevicesRepo(db);
			const service = createPairingService({
				devicesRepo: repo,
				clock: mockClock,
				ids: mockIds,
				dataDir: '/fake/data',
			});

			const { code } = service.createPairingCode(60);
			const { deviceId, token } = await service.claimPairingCode({
				code,
				deviceName: 'Device Secret Check',
			});

			const storedRow = repo.findById(deviceId);
			expect(storedRow).not.toBeNull();
			// Database row MUST NOT contain the plaintext token!
			expect(storedRow?.token_hash).not.toBe(token);
			expect(storedRow?.token_salt).toBeDefined();
			expect(storedRow?.token_hash).toHaveLength(128); // 64 bytes in hex = 128 chars
			expect(storedRow?.token_salt).toHaveLength(32); // 16 bytes in hex = 32 chars

			// Raw SQL inspection of all columns in devices table
			const rawRow = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Record<
				string,
				unknown
			>;
			for (const [col, val] of Object.entries(rawRow)) {
				expect(val, `Column ${col} should not contain plaintext token`).not.toBe(token);
			}

			// Authentication with raw token succeeds via timingSafeEqual
			const auth = service.authenticateToken(`Bearer ${token}`);
			expect(auth.deviceId).toBe(deviceId);
			expect(auth.deviceName).toBe('Device Secret Check');

			// Invalid token fails
			expect(() => service.authenticateToken('Bearer wrongtoken')).toThrow(AppError);
			expect(() => service.authenticateToken('Bearer wrongtoken')).toThrowError(
				/Invalid device token/,
			);
		});

		it('AC 3 & E-127: revoking a device immediately disconnects its active connections with 401 E_DEVICE_REVOKED', async () => {
			const repo = createDevicesRepo(db);
			const service = createPairingService({
				devicesRepo: repo,
				clock: mockClock,
				ids: mockIds,
				dataDir: '/fake/data',
			});

			const { code } = service.createPairingCode(60);
			const { deviceId, token } = await service.claimPairingCode({
				code,
				deviceName: 'Phone To Revoke',
			});

			// Register active connection
			const disconnectSpy = vi.fn();
			const unregister = service.registerConnection(deviceId, disconnectSpy);

			// Revoke device
			const revokeResult = service.revokeDevice(deviceId);
			expect(revokeResult.revokedAt).toBeDefined();

			// Disconnect callback was called immediately with E_DEVICE_REVOKED (E-127)
			expect(disconnectSpy).toHaveBeenCalledTimes(1);
			const errorArg = disconnectSpy.mock.calls[0]?.[0];
			expect(errorArg).toBeInstanceOf(AppError);
			expect(errorArg.code).toBe('E_DEVICE_REVOKED');

			// Subsequent calls with that token must throw E_DEVICE_REVOKED
			expect(() => service.authenticateToken(`Bearer ${token}`)).toThrow(AppError);
			expect(() => service.authenticateToken(`Bearer ${token}`)).toThrowError(
				/Device token has been revoked/,
			);

			// Unregister cleanly
			unregister();
		});

		it('AC 5 & E-226: bootstrap on zero devices prints to console, writes pairing-code.txt with POSIX 0600 mode and deletes after claim', async () => {
			const repo = createDevicesRepo(db);
			const consoleOutputs: string[] = [];
			const mockFsFiles = new Map<string, { content: string; mode: number }>();

			const mockFs: PairingFileSystem = {
				writeFileSync: (path, data, options) => {
					mockFsFiles.set(path, {
						content: data,
						mode: options?.mode ?? 0o666,
					});
				},
				chmodSync: (path, mode) => {
					const existing = mockFsFiles.get(path);
					if (existing) {
						existing.mode = mode;
					}
				},
				statSync: (path) => {
					const existing = mockFsFiles.get(path);
					return { mode: existing?.mode ?? 0o600 };
				},
				rmSync: (path) => {
					mockFsFiles.delete(path);
				},
				existsSync: (path) => mockFsFiles.has(path),
			};

			const service = createPairingService({
				devicesRepo: repo,
				clock: mockClock,
				ids: mockIds,
				dataDir: '/app/data',
				platform: 'linux',
				printConsole: (msg) => consoleOutputs.push(msg),
				fs: mockFs,
			});

			// Trigger bootstrap
			const bootResult = service.bootstrapIfNeeded();
			expect(bootResult.bootstrapped).toBe(true);
			expect(bootResult.code).toBeDefined();

			// Printed to console
			expect(
				consoleOutputs.some((line) => line.includes(`Initial pairing code: ${bootResult.code}`)),
			).toBe(true);

			// Written to pairing-code.txt with POSIX mode 0600
			const codeFilePath = '/app/data/pairing-code.txt';
			expect(mockFsFiles.has(codeFilePath)).toBe(true);
			const written = mockFsFiles.get(codeFilePath);
			expect(written?.content).toBe(bootResult.code);
			expect(written?.mode).toBe(0o600);

			// Claim the bootstrap code
			expect(bootResult.code).toBeDefined();
			const codeToClaim = bootResult.code ?? '';
			await service.claimPairingCode({
				code: codeToClaim,
				deviceName: 'Initial Desktop',
			});

			// "用后即删" - file is deleted upon claim!
			expect(mockFsFiles.has(codeFilePath)).toBe(false);

			// Subsequent bootstrap check returns false since active devices > 0
			expect(service.bootstrapIfNeeded().bootstrapped).toBe(false);
		});

		it('AC 5 Windows DACL: asserts icacls command is invoked with current user rights', () => {
			const repo = createDevicesRepo(db);
			const commandsRun: { file: string; args: readonly string[] }[] = [];
			const mockFsFiles = new Map<string, { content: string; mode: number }>();

			const mockFs: PairingFileSystem = {
				writeFileSync: (path, data) => {
					mockFsFiles.set(path, { content: data, mode: 0o666 });
				},
				chmodSync: () => {},
				statSync: () => ({ mode: 0o600 }),
				rmSync: (path) => {
					mockFsFiles.delete(path);
				},
				existsSync: (path) => mockFsFiles.has(path),
			};

			const service = createPairingService({
				devicesRepo: repo,
				clock: mockClock,
				ids: mockIds,
				dataDir: 'C:\\ProgramData\\agent-scheduler',
				platform: 'win32',
				currentUser: 'Alice',
				fs: mockFs,
				runCommand: (cmd) => {
					commandsRun.push(cmd);
					return { ok: true, stdout: 'Processed', stderr: '' };
				},
			});

			const cmd = buildWindowsDaclCommand(
				'C:\\ProgramData\\agent-scheduler\\pairing-code.txt',
				'Alice',
			);
			expect(cmd.file).toBe('icacls.exe');
			expect(cmd.args).toContain('Alice:F');
			expect(cmd.args).toContain('/inheritance:r');

			const res = service.bootstrapIfNeeded();
			expect(res.bootstrapped).toBe(true);
			expect(commandsRun).toHaveLength(1);
			expect(commandsRun[0]?.args).toContain('Alice:F');
		});

		it('AC 4: invalidatePairingCode invalidates current code and removes bootstrap file', () => {
			const repo = createDevicesRepo(db);
			const mockFsFiles = new Map<string, { content: string; mode: number }>();
			const mockFs: PairingFileSystem = {
				writeFileSync: (path, data) => mockFsFiles.set(path, { content: data, mode: 0o600 }),
				chmodSync: () => {},
				statSync: () => ({ mode: 0o600 }),
				rmSync: (path) => mockFsFiles.delete(path),
				existsSync: (path) => mockFsFiles.has(path),
			};

			const service = createPairingService({
				devicesRepo: repo,
				clock: mockClock,
				ids: mockIds,
				dataDir: '/data',
				fs: mockFs,
			});

			service.bootstrapIfNeeded();
			expect(service.getActivePairingCode()).not.toBeNull();
			expect(mockFsFiles.has('/data/pairing-code.txt')).toBe(true);

			service.invalidatePairingCode();
			expect(service.getActivePairingCode()).toBeNull();
			expect(mockFsFiles.has('/data/pairing-code.txt')).toBe(false);
		});
	});
});
