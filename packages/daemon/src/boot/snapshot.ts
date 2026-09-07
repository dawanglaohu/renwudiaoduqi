import { snapshotEnvironment } from '../config/env.ts';
import { takePlatformHostInputs } from '../platform/host.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';

export type RuntimeLogWriter = (line: string) => void;

export interface BootSnapshot {
	readonly nodeVersion: string;
	readonly pid: number;
	readonly environment: ReturnType<typeof snapshotEnvironment>;
	readonly hostInputs: PlatformHostInputs;
	readonly writeRunLog: RuntimeLogWriter;
	readonly startResident: () => Promise<never>;
}

export function takeBootSnapshot(): BootSnapshot {
	const environment = snapshotEnvironment();
	const hostResult = takePlatformHostInputs({
		appData: environment.host.appDataDir,
		xdgDataHome: environment.host.xdgDataHome,
	});
	if (!hostResult.ok) {
		throw new Error(hostResult.error.message);
	}

	return Object.freeze({
		nodeVersion: process.version,
		pid: process.pid,
		environment,
		hostInputs: hostResult.value,
		writeRunLog: (line: string): void => {
			process.stderr.write(`${line}\n`);
		},
		startResident: (): Promise<never> =>
			new Promise(() => {
				setInterval(() => {
					// keep the event loop alive
				}, 2_147_483_647);
			}),
	});
}
