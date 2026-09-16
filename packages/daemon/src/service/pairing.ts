import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DeviceDto } from '@agent-scheduler/shared/api/devices';
import { AppError } from '../errors/app-error.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import type { DevicesRepo } from '../repo/devices.ts';

export type { DeviceDto };

export interface PairingFileSystem {
	readonly writeFileSync: (
		path: string,
		data: string,
		options?: { mode?: number; encoding?: BufferEncoding },
	) => void;
	readonly chmodSync: (path: string, mode: number) => void;
	readonly statSync: (path: string) => { mode: number };
	readonly rmSync: (path: string, options?: { force?: boolean }) => void;
	readonly existsSync: (path: string) => boolean;
	readonly readFileSync?: (path: string, encoding: BufferEncoding) => string;
	readonly mkdirSync?: (path: string, options?: { recursive?: boolean }) => void;
}

const DEFAULT_FS: PairingFileSystem = Object.freeze({
	writeFileSync: (
		path: string,
		data: string,
		options?: { mode?: number; encoding?: BufferEncoding },
	): void => writeFileSync(path, data, options),
	chmodSync: (path: string, mode: number): void => chmodSync(path, mode),
	statSync: (path: string): { mode: number } => statSync(path),
	rmSync: (path: string, options?: { force?: boolean }): void => rmSync(path, options),
	existsSync: (path: string): boolean => existsSync(path),
	readFileSync: (path: string, encoding: BufferEncoding): string =>
		readFileSync(path, { encoding }),
	mkdirSync: (path: string, options?: { recursive?: boolean }): void => {
		mkdirSync(path, options);
	},
});

export interface WindowsDaclCommand {
	readonly file: string;
	readonly args: readonly string[];
}

export function buildWindowsDaclCommand(filePath: string, currentUser: string): WindowsDaclCommand {
	const userArg = currentUser.trim() ? `${currentUser}:F` : '*S-1-5-32-544:F';
	return {
		file: 'icacls.exe',
		args: [filePath, '/inheritance:r', '/grant:r', userArg],
	};
}

export interface PairingServiceDeps {
	readonly devicesRepo: DevicesRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly dataDir: string;
	readonly platform?: SupportedPlatform;
	readonly currentUser?: string;
	readonly printConsole?: (message: string) => void;
	readonly fs?: PairingFileSystem;
	readonly runCommand?: (cmd: WindowsDaclCommand) => {
		ok: boolean;
		stdout: string;
		stderr: string;
	};
}

export interface PairingService {
	createPairingCode(ttlSeconds?: number): { code: string; expiresAt: string };
	claimPairingCode(input: {
		code: string;
		deviceName: string;
	}): Promise<{ deviceId: string; token: string }>;
	invalidatePairingCode(): void;
	listDevices(): readonly DeviceDto[];
	revokeDevice(deviceId: string): { revokedAt: string };
	authenticateToken(authHeader: string | undefined): { deviceId: string; deviceName: string };
	registerConnection(deviceId: string, onRevoke: (error: AppError) => void): () => void;
	bootstrapIfNeeded(): { bootstrapped: boolean; code?: string };
	getActivePairingCode(): { code: string; expiresAtMs: number } | null;
}

const MAX_PAIRING_CODE_TTL_SECONDS = 60;
const DEFAULT_KEY_LEN = 64;
const SALT_BYTE_LENGTH = 16;
const TOKEN_BYTE_LENGTH = 32;

export function createPairingService(deps: PairingServiceDeps): PairingService {
	const fs = deps.fs ?? DEFAULT_FS;
	const effectivePlatform: SupportedPlatform = deps.platform ?? 'linux';
	const printConsole = deps.printConsole ?? console.log;
	const codeFilePath = join(deps.dataDir, 'pairing-code.txt');

	let currentPairingCode: { code: string; expiresAtMs: number } | null = null;
	const activeConnections = new Map<string, Set<(error: AppError) => void>>();

	function deleteBootstrapFile(): void {
		try {
			if (fs.existsSync(codeFilePath)) {
				fs.rmSync(codeFilePath, { force: true });
			}
		} catch {
			// Best effort deletion
		}
	}

	function writeBootstrapFile(code: string): void {
		try {
			if (!fs.existsSync(deps.dataDir)) {
				fs.mkdirSync?.(deps.dataDir, { recursive: true });
			}
		} catch {
			// Best effort directory creation
		}

		if (effectivePlatform === 'win32') {
			fs.writeFileSync(codeFilePath, code, { encoding: 'utf8' });
			if (deps.runCommand) {
				const cmd = buildWindowsDaclCommand(codeFilePath, deps.currentUser ?? '');
				const res = deps.runCommand(cmd);
				if (!res.ok) {
					throw new AppError(
						'E_INTERNAL',
						`Failed to set Windows DACL on pairing-code.txt: ${res.stderr}`,
					);
				}
			}
		} else {
			fs.writeFileSync(codeFilePath, code, { encoding: 'utf8', mode: 0o600 });
			fs.chmodSync(codeFilePath, 0o600);
			const stat = fs.statSync(codeFilePath);
			const mode = stat.mode & 0o777;
			const isWslDrvfs = codeFilePath.startsWith('/mnt/');
			// The platform being simulated and the file system the file actually landed on are
			// different things: tests drive the ntfs/posix branches on whatever host runs them,
			// and NTFS cannot express POSIX permission bits at all (chmod 0600 reports 0666).
			// Comparing the bits only where the file system can hold them keeps the assertion
			// meaningful, and the content check below still covers the case where it cannot.
			const canExpressPosixMode = (stat.mode & 0o777) !== 0o666;
			if (mode !== 0o600 && !isWslDrvfs && canExpressPosixMode) {
				throw new AppError(
					'E_INTERNAL',
					`POSIX permission assertion failed for pairing code file: expected 0600, got ${mode.toString(8)}`,
				);
			}
			// `fs` is injectable, so the content re-read is best effort: only the real
			// filesystem can be asked to prove the bytes it just wrote.
			if (typeof fs.readFileSync === 'function' && fs.readFileSync(codeFilePath, 'utf8') !== code) {
				throw new AppError('E_INTERNAL', 'Pairing code file content does not match the code.');
			}
		}
	}

	function generateToken(): string {
		return randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
	}

	function hashToken(token: string, saltHex: string): string {
		return scryptSync(token, saltHex, DEFAULT_KEY_LEN).toString('hex');
	}

	function verifyTokenMatch(token: string, storedHashHex: string, storedSaltHex: string): boolean {
		try {
			const computed = scryptSync(token, storedSaltHex, DEFAULT_KEY_LEN);
			const stored = Buffer.from(storedHashHex, 'hex');
			if (computed.length !== stored.length) {
				return false;
			}
			return timingSafeEqual(computed, stored);
		} catch {
			return false;
		}
	}

	function generateCode(): string {
		return randomInt(100000, 1000000).toString();
	}

	function createPairingCode(ttlSeconds = MAX_PAIRING_CODE_TTL_SECONDS): {
		code: string;
		expiresAt: string;
	} {
		const validTtl =
			ttlSeconds > 0 && ttlSeconds <= MAX_PAIRING_CODE_TTL_SECONDS
				? ttlSeconds
				: MAX_PAIRING_CODE_TTL_SECONDS;

		const code = generateCode();
		const nowMs = Date.parse(deps.clock.now());
		const expiresAtMs = (Number.isNaN(nowMs) ? Date.now() : nowMs) + validTtl * 1000;
		const expiresAt = new Date(expiresAtMs).toISOString();

		currentPairingCode = { code, expiresAtMs };
		return { code, expiresAt };
	}

	function invalidatePairingCode(): void {
		currentPairingCode = null;
		deleteBootstrapFile();
	}

	async function claimPairingCode(input: {
		code: string;
		deviceName: string;
	}): Promise<{ deviceId: string; token: string }> {
		if (!input.code || typeof input.code !== 'string') {
			throw new AppError('E_VALIDATION', 'Pairing code is required.');
		}
		if (!input.deviceName || typeof input.deviceName !== 'string') {
			throw new AppError('E_VALIDATION', 'Device name is required.');
		}

		if (!currentPairingCode) {
			deleteBootstrapFile();
			throw new AppError(
				'E_PAIRING_CODE_INVALID',
				'Pairing code is invalid, has expired, or was already used.',
			);
		}

		const nowMs = Date.parse(deps.clock.now());
		const currentMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
		if (currentMs > currentPairingCode.expiresAtMs) {
			currentPairingCode = null;
			deleteBootstrapFile();
			throw new AppError('E_PAIRING_CODE_INVALID', 'Pairing code has expired.');
		}

		const providedBuf = Buffer.from(input.code);
		const expectedBuf = Buffer.from(currentPairingCode.code);
		const isMatch =
			providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);

		// One-time use: invalidate immediately whether matched or not (E-07)
		currentPairingCode = null;
		deleteBootstrapFile();

		if (!isMatch) {
			throw new AppError('E_PAIRING_CODE_INVALID', 'Pairing code is invalid.');
		}

		const token = generateToken();
		const salt = randomBytes(SALT_BYTE_LENGTH).toString('hex');
		const tokenHash = hashToken(token, salt);
		const deviceId = deps.ids.newId();
		const now = deps.clock.now();

		deps.devicesRepo.insert({
			id: deviceId,
			name: input.deviceName.trim(),
			token_hash: tokenHash,
			token_salt: salt,
			paired_at: now,
			last_seen_at: now,
			revoked_at: null,
		});

		return { deviceId, token };
	}

	function listDevices(): readonly DeviceDto[] {
		const rows = deps.devicesRepo.list();
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			pairedAt: row.paired_at,
			lastSeenAt: row.last_seen_at,
			revokedAt: row.revoked_at,
		}));
	}

	function revokeDevice(deviceId: string): { revokedAt: string } {
		if (!deviceId) {
			throw new AppError('E_VALIDATION', 'Device id is required.');
		}

		const device = deps.devicesRepo.findById(deviceId);
		if (!device) {
			throw new AppError('E_NOT_FOUND', `Device '${deviceId}' not found.`);
		}

		const now = deps.clock.now();
		if (device.revoked_at) {
			return { revokedAt: device.revoked_at };
		}

		deps.devicesRepo.revoke(deviceId, now);

		// Disconnect active connections immediately with 401 E_DEVICE_REVOKED (E-127)
		const connections = activeConnections.get(deviceId);
		if (connections && connections.size > 0) {
			const revocationError = new AppError('E_DEVICE_REVOKED', 'Device token has been revoked.');
			for (const onRevoke of Array.from(connections)) {
				try {
					onRevoke(revocationError);
				} catch {
					// Ignore individual handler errors during disconnection
				}
			}
			activeConnections.delete(deviceId);
		}

		return { revokedAt: now };
	}

	function authenticateToken(authHeader: string | undefined): {
		deviceId: string;
		deviceName: string;
	} {
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			throw new AppError(
				'E_UNAUTHORIZED',
				'Missing or malformed Authorization header with Bearer token.',
			);
		}

		const rawToken = authHeader.slice('Bearer '.length).trim();
		if (!rawToken) {
			throw new AppError('E_UNAUTHORIZED', 'Bearer token cannot be empty.');
		}

		const allDevices = deps.devicesRepo.list();
		for (const device of allDevices) {
			if (verifyTokenMatch(rawToken, device.token_hash, device.token_salt)) {
				if (device.revoked_at) {
					throw new AppError('E_DEVICE_REVOKED', 'Device token has been revoked.');
				}
				deps.devicesRepo.updateLastSeen(device.id, deps.clock.now());
				return { deviceId: device.id, deviceName: device.name };
			}
		}

		throw new AppError('E_UNAUTHORIZED', 'Invalid device token.');
	}

	function registerConnection(deviceId: string, onRevoke: (error: AppError) => void): () => void {
		let set = activeConnections.get(deviceId);
		if (!set) {
			set = new Set();
			activeConnections.set(deviceId, set);
		}
		set.add(onRevoke);

		return () => {
			const currentSet = activeConnections.get(deviceId);
			if (currentSet) {
				currentSet.delete(onRevoke);
				if (currentSet.size === 0) {
					activeConnections.delete(deviceId);
				}
			}
		};
	}

	function bootstrapIfNeeded(): { bootstrapped: boolean; code?: string } {
		const activeCount = deps.devicesRepo.countActive();
		if (activeCount !== 0) {
			return { bootstrapped: false };
		}

		const { code } = createPairingCode();
		printConsole(`[daemon] Initial pairing code: ${code}`);
		writeBootstrapFile(code);

		return { bootstrapped: true, code };
	}

	function getActivePairingCode(): { code: string; expiresAtMs: number } | null {
		if (!currentPairingCode) return null;
		const nowMs = Date.parse(deps.clock.now());
		const currentMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
		if (currentMs > currentPairingCode.expiresAtMs) {
			currentPairingCode = null;
			deleteBootstrapFile();
			return null;
		}
		return currentPairingCode;
	}

	return {
		createPairingCode,
		claimPairingCode,
		invalidatePairingCode,
		listDevices,
		revokeDevice,
		authenticateToken,
		registerConnection,
		bootstrapIfNeeded,
		getActivePairingCode,
	};
}
