import { isRecord } from '@agent-scheduler/shared/lib/is-record';
import type {
	LockFileHandle,
	LockMetadata,
	NativeLockAdapter,
	ProbeLiveness,
} from '../platform/lock-contract.ts';
import {
	healthProbeHost,
	parseLockMetadata,
	serializeLockMetadata,
} from '../platform/lock-contract.ts';

export type LockHandle = LockFileHandle;
export type LockProcessLiveness = ProbeLiveness;

export interface ProcessLivenessProbe {
	check(pid: number): LockProcessLiveness;
}

export type HealthProbeOutcome =
	| { readonly kind: 'success'; readonly status: number; readonly bodyOk: boolean }
	| { readonly kind: 'failure'; readonly reason: 'timeout' | 'connect-failed' };

export interface HealthProbe {
	probe(input: {
		readonly host: string;
		readonly port: number;
		readonly path?: string;
		readonly timeoutMs?: number;
	}): Promise<HealthProbeOutcome>;
}

export type AcquireLockOutcome =
	| { readonly ok: true; readonly lock: LockFileHandle }
	| { readonly ok: false; readonly reason: 'already-held'; readonly metadata: LockMetadata }
	| { readonly ok: false; readonly reason: 'permission-denied'; readonly lines: readonly string[] }
	| {
			readonly ok: false;
			readonly reason: 'stale-lock-kept';
			readonly live: {
				readonly process: LockProcessLiveness;
				readonly health: 'alive' | 'dead' | 'uncertain';
			};
	  }
	| { readonly ok: false; readonly reason: 'lock-invalid' }
	| { readonly ok: false; readonly reason: 'lock-unreadable' };

export interface InstanceLockDependencies {
	readonly adapter: NativeLockAdapter;
	readonly processProbe: ProcessLivenessProbe;
	readonly healthProbe: HealthProbe;
}

export async function acquireInstanceLock(
	metadata: LockMetadata,
	dependencies: InstanceLockDependencies,
): Promise<AcquireLockOutcome> {
	const serialized = serializeLockMetadata(metadata);
	const createResult = dependencies.adapter.createExclusive(serialized);
	if (createResult.ok) {
		const permissions = dependencies.adapter.verifyPermissions();
		if (!permissions.ok) {
			const contents = dependencies.adapter.read();
			if (contents.ok && contents.contents === serialized) dependencies.adapter.remove();
			return {
				ok: false,
				reason: 'permission-denied',
				lines: dependencies.adapter.permissionLines,
			};
		}
		return { ok: true, lock: makeHandle(metadata, serialized, dependencies.adapter) };
	}
	if (createResult.failure.kind === 'already-exists') {
		return handleExistingLock(metadata, serialized, dependencies);
	}
	if (
		createResult.failure.kind === 'permission-denied' ||
		createResult.failure.kind === 'invalid-permissions'
	) {
		return {
			ok: false,
			reason: 'permission-denied',
			lines: dependencies.adapter.permissionLines,
		};
	}
	return { ok: false, reason: 'lock-unreadable' };
}

async function handleExistingLock(
	metadata: LockMetadata,
	serialized: string,
	dependencies: InstanceLockDependencies,
): Promise<AcquireLockOutcome> {
	const permissions = dependencies.adapter.verifyPermissions();
	if (!permissions.ok) {
		return {
			ok: false,
			reason: 'permission-denied',
			lines: dependencies.adapter.permissionLines,
		};
	}
	const existing = dependencies.adapter.read();
	if (!existing.ok) return { ok: false, reason: 'lock-unreadable' };
	const existingMetadata = parseLockMetadata(existing.contents);
	if (existingMetadata === null) return { ok: false, reason: 'lock-invalid' };
	const processState = dependencies.processProbe.check(existingMetadata.pid);
	const healthState = await probeHealth(existingMetadata, dependencies);
	if (processState === 'alive' && healthState === 'alive') {
		return { ok: false, reason: 'already-held', metadata: existingMetadata };
	}
	if (processState !== 'dead' || healthState !== 'dead') {
		return {
			ok: false,
			reason: 'stale-lock-kept',
			live: { process: processState, health: healthState },
		};
	}
	return reclaimStaleLock(metadata, serialized, existing.contents, dependencies);
}

async function reclaimStaleLock(
	metadata: LockMetadata,
	serialized: string,
	expectedContents: string,
	dependencies: InstanceLockDependencies,
): Promise<AcquireLockOutcome> {
	const guard = await acquireReclaimGuard(metadata, serialized, dependencies);
	if (guard !== 'acquired') return guard;
	try {
		const current = dependencies.adapter.read();
		if (!current.ok || current.contents !== expectedContents) {
			return {
				ok: false,
				reason: 'stale-lock-kept',
				live: { process: 'uncertain', health: 'uncertain' },
			};
		}
		const removal = dependencies.adapter.remove();
		if (!removal.ok) return { ok: false, reason: 'lock-unreadable' };
		return acquireInstanceLock(metadata, dependencies);
	} finally {
		dependencies.adapter.removeReclaimGuard();
	}
}

async function acquireReclaimGuard(
	metadata: LockMetadata,
	serialized: string,
	dependencies: InstanceLockDependencies,
): Promise<'acquired' | AcquireLockOutcome> {
	const guard = dependencies.adapter.createReclaimGuard(serialized);
	if (guard.ok) return 'acquired';
	if (guard.failure.kind === 'permission-denied' || guard.failure.kind === 'invalid-permissions') {
		return {
			ok: false,
			reason: 'permission-denied',
			lines: dependencies.adapter.permissionLines,
		};
	}
	if (guard.failure.kind !== 'already-exists') {
		return { ok: false, reason: 'lock-unreadable' };
	}
	const existingGuard = dependencies.adapter.readReclaimGuard();
	if (!existingGuard.ok) return { ok: false, reason: 'lock-unreadable' };
	const guardMetadata = parseLockMetadata(existingGuard.contents);
	if (guardMetadata === null) return { ok: false, reason: 'lock-invalid' };
	const processState = dependencies.processProbe.check(guardMetadata.pid);
	const healthState = await probeHealth(guardMetadata, dependencies);
	if (processState !== 'dead' || healthState !== 'dead') {
		return {
			ok: false,
			reason: 'stale-lock-kept',
			live: { process: processState, health: healthState },
		};
	}
	const currentGuard = dependencies.adapter.readReclaimGuard();
	if (!currentGuard.ok || currentGuard.contents !== existingGuard.contents) {
		return {
			ok: false,
			reason: 'stale-lock-kept',
			live: { process: 'uncertain', health: 'uncertain' },
		};
	}
	const removal = dependencies.adapter.removeReclaimGuard();
	if (!removal.ok) return { ok: false, reason: 'lock-unreadable' };
	return acquireReclaimGuard(metadata, serialized, dependencies);
}

async function probeHealth(
	metadata: LockMetadata,
	dependencies: InstanceLockDependencies,
): Promise<'alive' | 'dead' | 'uncertain'> {
	const outcome = await dependencies.healthProbe.probe({
		host: healthProbeHost(metadata.bind),
		port: metadata.port,
		path: '/api/v1/health',
		timeoutMs: 1_000,
	});
	if (outcome.kind === 'failure') {
		return outcome.reason === 'timeout' ? 'uncertain' : 'dead';
	}
	return outcome.status >= 200 && outcome.status < 300 && outcome.bodyOk ? 'alive' : 'uncertain';
}

function makeHandle(
	metadata: LockMetadata,
	serializedMetadata: string,
	adapter: NativeLockAdapter,
): LockFileHandle {
	let released = false;
	return {
		path: adapter.filePath,
		metadata,
		serializedMetadata,
		get released() {
			return released;
		},
		release(): void {
			released = true;
		},
	};
}

export function createSystemProcessLivenessProbe(): ProcessLivenessProbe {
	return Object.freeze({
		check(pid: number): LockProcessLiveness {
			if (!Number.isInteger(pid) || pid <= 0) return 'dead';
			try {
				process.kill(pid, 0);
				return 'alive';
			} catch (error) {
				return getErrorCode(error) === 'ESRCH' ? 'dead' : 'uncertain';
			}
		},
	});
}

export function createHttpHealthProbe(fetchImplementation: typeof fetch = fetch): HealthProbe {
	return Object.freeze({
		async probe(input: Parameters<HealthProbe['probe']>[0]): Promise<HealthProbeOutcome> {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 1_000);
			try {
				const response = await fetchImplementation(
					`http://${formatHost(input.host)}:${input.port}${input.path ?? '/api/v1/health'}`,
					{ signal: controller.signal, headers: { accept: 'application/json' } },
				);
				let bodyOk = false;
				try {
					const body = (await response.json()) as unknown;
					bodyOk = isRecord(body) && body.ok === true;
				} catch {
					bodyOk = false;
				}
				return { kind: 'success', status: response.status, bodyOk };
			} catch (error) {
				return {
					kind: 'failure',
					reason:
						error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'connect-failed',
				};
			} finally {
				clearTimeout(timeout);
			}
		},
	});
}

export function acquireLockOutcomeToBootLines(
	outcome: Extract<AcquireLockOutcome, { readonly ok: false }>,
): readonly string[] {
	switch (outcome.reason) {
		case 'already-held':
			return [
				`Existing instance pid=${outcome.metadata.pid} port=${outcome.metadata.port}`,
				'Refusing to start; connect to the already-running instance.',
			];
		case 'permission-denied':
			return outcome.lines;
		case 'stale-lock-kept':
			return [
				`Lock is uncertain: process=${outcome.live.process} health=${outcome.live.health}.`,
				'Refusing to delete a lock whose holder state cannot be determined.',
			];
		case 'lock-invalid':
			return ['The existing lock file is invalid and cannot be automatically reclaimed.'];
		case 'lock-unreadable':
			return ['The existing lock file could not be read or reclaimed atomically.'];
	}
}

export function releaseInstanceLock(lock: LockFileHandle, adapter: NativeLockAdapter): void {
	if (lock.released) return;
	const current = adapter.read();
	if (!current.ok) {
		if (current.failure.kind === 'not-found') {
			lock.release();
			return;
		}
		throw current.failure.error;
	}
	if (current.ok && current.contents === lock.serializedMetadata) {
		const removal = adapter.remove();
		if (!removal.ok) throw removal.failure.error;
	}
	lock.release();
}

function formatHost(host: string): string {
	return host.includes(':') ? `[${host}]` : host;
}

function getErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}
