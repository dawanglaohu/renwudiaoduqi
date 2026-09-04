import { homedir } from 'node:os';
import { snapshotEnvironment } from '../config/env.ts';
import type { LockHandle } from './lock.ts';

export type RuntimeLogWriter = (line: string) => void;

export interface BootSnapshot {
	readonly nodeVersion: string;
	readonly pid: number;
	readonly environment: ReturnType<typeof snapshotEnvironment>;
	readonly homeDir: string;
	readonly writeRunLog: RuntimeLogWriter;
	readonly stayResident: (lock: LockHandle) => Promise<never>;
}

export function takeBootSnapshot(): BootSnapshot {
	return Object.freeze({
		nodeVersion: process.version,
		pid: process.pid,
		environment: snapshotEnvironment(),
		homeDir: homedir(),
		writeRunLog(line: string): void {
			process.stderr.write(`${line}\n`);
		},
		stayResident(lock: LockHandle): Promise<never> {
			return new Promise(() => {
				// The active handle keeps the successful daemon alive and retains its lock handle.
				setInterval(() => {
					void lock.pid;
				}, 2_147_483_647);
			});
		},
	});
}
