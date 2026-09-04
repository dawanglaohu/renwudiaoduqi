import type { EnvironmentSnapshot, ProcessConfigResult } from '../config/env.ts';
import { parseProcessConfig } from '../config/env.ts';
import { type AcquireInstanceLockResult, acquireInstanceLock } from './lock.ts';
import { resolveLockFilePath } from './paths.ts';
import type { BootSnapshot, RuntimeLogWriter } from './snapshot.ts';

export interface AppContainer {
	readonly nodeVersion: string;
	readonly pid: number;
	readonly productEnvironment: EnvironmentSnapshot['product'];
	readonly writeRunLog: RuntimeLogWriter;
	readonly parseProcessConfig: () => ProcessConfigResult;
	readonly acquireInstanceLock: () => AcquireInstanceLockResult;
	readonly stayResident: BootSnapshot['stayResident'];
}

export function createContainer(snapshot: BootSnapshot): AppContainer {
	return Object.freeze({
		nodeVersion: snapshot.nodeVersion,
		pid: snapshot.pid,
		productEnvironment: snapshot.environment.product,
		writeRunLog: snapshot.writeRunLog,
		parseProcessConfig: () => parseProcessConfig(snapshot.environment.product),
		acquireInstanceLock: () =>
			acquireInstanceLock(
				resolveLockFilePath({
					appDataDir: snapshot.environment.host.appDataDir,
					homeDir: snapshot.homeDir,
				}),
				snapshot.pid,
			),
		stayResident: snapshot.stayResident,
	});
}
