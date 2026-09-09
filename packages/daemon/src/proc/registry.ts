import type { ManagedProcess } from './spawn.ts';

export interface ProcessRegistry {
	register(process: ManagedProcess): void;
	get(runId: string): ManagedProcess | undefined;
	getByPid(pid: number): ManagedProcess | undefined;
	has(runId: string): boolean;
	unregister(runId: string): boolean;
	list(): readonly ManagedProcess[];
	readonly size: number;
	clear(): void;
}

export function createProcessRegistry(): ProcessRegistry {
	const byRunId = new Map<string, ManagedProcess>();
	const byPid = new Map<number, ManagedProcess>();

	return {
		register(process: ManagedProcess): void {
			byRunId.set(process.runId, process);
			if (process.pid > 0) {
				byPid.set(process.pid, process);
			}
		},

		get(runId: string): ManagedProcess | undefined {
			return byRunId.get(runId);
		},

		getByPid(pid: number): ManagedProcess | undefined {
			return byPid.get(pid);
		},

		has(runId: string): boolean {
			return byRunId.has(runId);
		},

		unregister(runId: string): boolean {
			const process = byRunId.get(runId);
			if (process === undefined) return false;
			byRunId.delete(runId);
			if (process.pid > 0) {
				byPid.delete(process.pid);
			}
			return true;
		},

		list(): readonly ManagedProcess[] {
			return Object.freeze([...byRunId.values()]);
		},

		get size(): number {
			return byRunId.size;
		},

		clear(): void {
			byRunId.clear();
			byPid.clear();
		},
	};
}
