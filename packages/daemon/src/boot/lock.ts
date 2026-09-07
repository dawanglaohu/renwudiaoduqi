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
	| { readonly kind: 'failure'; readonly reason: string };

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
				readonly health: 'success' | 'failure' | 'uncertain';
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
		return { ok: true, lock: makeHandle(metadata, dependencies.adapter) };
	}
	if (createResult.error.code === 'EEXIST') {
		return handleExistingLock(metadata, dependencies);
	}
	if (createResult.error.code === 'EACCES' || createResult.error.code === 'EPERM') {
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
	dependencies: InstanceLockDependencies,
): Promise<AcquireLockOutcome> {
	const existing = dependencies.adapter.read();
	if (!existing.ok) {
		return { ok: false, reason: 'lock-unreadable' };
	}
	const existingMetadata = parseLockMetadata(existing.contents);
	if (existingMetadata === null) {
		return { ok: false, reason: 'lock-invalid' };
	}
	const processState = dependencies.processProbe.check(existingMetadata.pid);
	const healthState = await probeHealth(existingMetadata, dependencies);
	if (processState === 'alive' && healthState === 'success') {
		return { ok: false, reason: 'already-held', metadata: existingMetadata };
	}
	if (processState === 'dead' && healthState === 'failure') {
		const removeResult = dependencies.adapter.remove();
		if (!removeResult.ok) {
			return { ok: false, reason: 'lock-unreadable' };
		}
		return acquireInstanceLock(metadata, dependencies);
	}
	return {
		ok: false,
		reason: 'stale-lock-kept',
		live: {
			process: processState,
			health:
				healthState === 'success' ? 'success' : healthState === 'failure' ? 'failure' : 'uncertain',
		},
	};
}

async function probeHealth(
	metadata: LockMetadata,
	dependencies: InstanceLockDependencies,
): Promise<'success' | 'failure' | 'uncertain'> {
	const host = healthProbeHost(metadata.bind);
	const outcome = await dependencies.healthProbe.probe({
		host,
		port: metadata.port,
		path: '/api/v1/health',
		timeoutMs: 1_000,
	});
	if (outcome.kind === 'failure') {
		return outcome.reason === 'timeout' ? 'uncertain' : 'failure';
	}
	if (!outcome.bodyOk) return 'uncertain';
	return 'success';
}

function makeHandle(metadata: LockMetadata, adapter: NativeLockAdapter): LockFileHandle {
	let released = false;
	return {
		path: adapter.filePath,
		metadata,
		get released() {
			return released;
		},
		release(): void {
			if (!released) {
				released = true;
			}
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
				const code = getErrorCode(error);
				if (code === 'ESRCH') return 'dead';
				return 'uncertain';
			}
		},
	});
}

export function createHttpHealthProbe(fetchImplementation: typeof fetch = fetch): HealthProbe {
	return Object.freeze({
		async probe(input: {
			readonly host: string;
			readonly port: number;
			readonly path?: string;
			readonly timeoutMs?: number;
		}): Promise<HealthProbeOutcome> {
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
					bodyOk =
						typeof body === 'object' &&
						body !== null &&
						(body as Record<string, unknown>).ok === true;
				} catch {
					bodyOk = false;
				}
				return { kind: 'success', status: response.status, bodyOk };
			} catch (error) {
				const reason =
					error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'connect-failed';
				return { kind: 'failure', reason };
			} finally {
				clearTimeout(timeout);
			}
		},
	});
}

function formatHost(host: string): string {
	return host.includes(':') ? `[${host}]` : host;
}

export function acquireLockOutcomeToBootLines(
	outcome: Extract<AcquireLockOutcome, { readonly ok: false }>,
): readonly string[] {
	switch (outcome.reason) {
		case 'already-held':
			return [
				`Existing instance pid=${outcome.metadata.pid} port=${outcome.metadata.port}`,
				'Refusing to start; hand the request to the already-running instance.',
			];
		case 'permission-denied':
			return outcome.lines;
		case 'stale-lock-kept':
			return [
				`Lock is uncertain: process=${outcome.live.process} health=${outcome.live.health}.`,
				'Refusing to delete a lock whose holder state cannot be determined; check the holder pid and port.',
			];
		case 'lock-invalid':
			return ['The existing lock file is invalid and cannot be automatically reclaimed.'];
		case 'lock-unreadable':
			return ['The existing lock file could not be read or reclaimed atomically.'];
	}
}

export async function releaseInstanceLock(
	lock: LockFileHandle,
	adapter: NativeLockAdapter,
): Promise<void> {
	if (lock.released) return;
	const removal = adapter.remove();
	if (!removal.ok) {
		throw removal.error;
	}
	lock.release();
}

function getErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}
