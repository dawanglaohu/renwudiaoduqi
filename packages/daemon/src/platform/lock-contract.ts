import { isRecord } from '@agent-scheduler/shared/lib/is-record';
import type { AppError } from '../errors/app-error.ts';
import type { SupportedPlatform } from './contract.ts';

export const LOCK_FILE_NAME = 'daemon.lock';
export const APPLICATION_DIRECTORY_NAME = 'agent-scheduler';
export const LOCK_FILE_MODE = 0o600;
export const LOCK_DIRECTORY_MODE = 0o755;
export const POSIX_LOCK_FILE_MODE_OCTAL = '600';
export const POSIX_LOCK_DIRECTORY_MODE_OCTAL = '755';
export const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';
export const WINDOWS_SYSTEM_SID = 'S-1-5-18';

export const LOCK_METADATA_FIELDS = ['pid', 'uid', 'startedAt', 'port', 'bind'] as const;

export type LockMetadataField = (typeof LOCK_METADATA_FIELDS)[number];

export interface LockMetadata {
	readonly pid: number;
	readonly uid: string;
	readonly startedAt: string;
	readonly port: number;
	readonly bind: string;
}

export interface LockPathHost {
	readonly programData?: string;
	readonly systemRoot?: string;
}

export interface LockIdentity {
	readonly uid: string;
}

export interface LockPermissionRequirement {
	readonly owner: string;
	readonly group: string;
	readonly mode: number;
}

export interface PosixLockPermissionSpec {
	readonly ownerName: string;
	readonly groupName: string;
	readonly ownerId: number;
	readonly groupId: number;
	readonly fileMode: number;
	readonly directoryMode: number;
}

export interface WindowsLockAclEntry {
	readonly sid: string;
	readonly name: string;
	readonly rights: 'F' | 'M';
	readonly inherit: boolean;
}

export interface WindowsLockAclSpec {
	readonly inherit: false;
	readonly entries: readonly WindowsLockAclEntry[];
}

export interface NativeLockCommand {
	readonly file: string;
	readonly args: readonly string[];
}

export interface NativeLockCommandResult {
	readonly ok: boolean;
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type ProbeLiveness = 'alive' | 'dead' | 'uncertain';

export interface LockFileHandle {
	readonly path: string;
	readonly metadata: LockMetadata;
	readonly serializedMetadata: string;
	readonly released: boolean;
	release(): void;
}

export type NativeLockFailureKind =
	| 'already-exists'
	| 'permission-denied'
	| 'not-found'
	| 'invalid-permissions'
	| 'internal';

export interface NativeLockFailure {
	readonly kind: NativeLockFailureKind;
	readonly error: AppError;
}

export type NativeLockWriteResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly failure: NativeLockFailure };

export type NativeLockReadResult =
	| { readonly ok: true; readonly contents: string }
	| { readonly ok: false; readonly failure: NativeLockFailure };

export interface NativeLockAdapter {
	readonly platform: SupportedPlatform;
	readonly filePath: string;
	readonly dirPath: string;
	readonly reclaimPath: string;
	readonly permissionLines: readonly string[];
	createExclusive(contents: string): NativeLockWriteResult;
	read(): NativeLockReadResult;
	remove(): NativeLockWriteResult;
	verifyPermissions(): NativeLockWriteResult;
	createReclaimGuard(contents: string): NativeLockWriteResult;
	readReclaimGuard(): NativeLockReadResult;
	removeReclaimGuard(): NativeLockWriteResult;
	inspectPermissions(): NativeLockReadResult;
}

export function isWildcardBind(bind: string): boolean {
	return bind === '0.0.0.0' || bind === '::' || bind === '*';
}

export function healthProbeHost(bind: string): string {
	if (bind === '::' || bind === '*') return '::1';
	if (bind === '0.0.0.0') return '127.0.0.1';
	return bind;
}

export function serializeLockMetadata(metadata: LockMetadata): string {
	return `${JSON.stringify({
		pid: metadata.pid,
		uid: metadata.uid,
		startedAt: metadata.startedAt,
		port: metadata.port,
		bind: metadata.bind,
	})}\n`;
}

export function parseLockMetadata(contents: string): LockMetadata | null {
	const trimmed = contents.trim();
	if (trimmed.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (!LOCK_METADATA_FIELDS.every((field) => Object.hasOwn(parsed, field))) return null;
	if (!isPositiveInteger(parsed.pid) || !isPositiveInteger(parsed.port)) return null;
	if (typeof parsed.uid !== 'string' || parsed.uid.length === 0) return null;
	if (typeof parsed.startedAt !== 'string' || parsed.startedAt.length === 0) return null;
	if (typeof parsed.bind !== 'string' || parsed.bind.length === 0) return null;
	return Object.freeze({
		pid: parsed.pid,
		uid: parsed.uid,
		startedAt: parsed.startedAt,
		port: parsed.port,
		bind: parsed.bind,
	});
}

export function combineProbeResults(
	processLive: ProbeLiveness,
	healthLive: ProbeLiveness,
): {
	readonly bothAlive: boolean;
	readonly bothDead: boolean;
	readonly keepExisting: boolean;
} {
	const bothAlive = processLive === 'alive' && healthLive === 'alive';
	const bothDead = processLive === 'dead' && healthLive === 'dead';
	return {
		bothAlive,
		bothDead,
		keepExisting: !bothAlive && !bothDead,
	};
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
