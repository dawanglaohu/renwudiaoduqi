import type { ProcessConfig } from '../config/env.ts';
import type { DatabaseConnection } from '../db/open-database.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../platform/lock-contract.ts';

export interface AppContainer {
	readonly config: ProcessConfig;
	readonly database: DatabaseConnection;
	readonly platform: {
		readonly hostInputs: PlatformHostInputs;
		readonly lock: NativeLockAdapter;
	};
	readonly clock: {
		readonly now: () => string;
	};
	readonly ids: Record<string, never>;
	readonly repos: Record<string, never>;
	readonly logstore: Record<string, never>;
	readonly events: Record<string, never>;
	readonly proc: Record<string, never>;
	readonly adapters: Record<string, never>;
	readonly workspace: Record<string, never>;
	readonly services: Record<string, never>;
	readonly jobs: readonly never[];
	readonly instanceLock: LockFileHandle;
}

export function createContainer(input: {
	readonly config: ProcessConfig;
	readonly database: DatabaseConnection;
	readonly hostInputs: PlatformHostInputs;
	readonly lockAdapter: NativeLockAdapter;
	readonly instanceLock: LockFileHandle;
	readonly clock: { readonly now: () => string };
}): AppContainer {
	const empty = Object.freeze({});
	return Object.freeze({
		config: input.config,
		database: input.database,
		platform: Object.freeze({ hostInputs: input.hostInputs, lock: input.lockAdapter }),
		clock: input.clock,
		ids: empty,
		repos: empty,
		logstore: empty,
		events: empty,
		proc: empty,
		adapters: empty,
		workspace: empty,
		services: empty,
		jobs: Object.freeze([]),
		instanceLock: input.instanceLock,
	});
}
