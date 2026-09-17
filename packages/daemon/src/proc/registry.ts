import type { ManagedProcess } from './spawn.ts';

export interface ProcessRegistry {
	register(process: ManagedProcess): void;
	get(runId: string): ManagedProcess | undefined;
	getByPid(pid: number): ManagedProcess | undefined;
	has(runId: string): boolean;
	hasPid(pid: number): boolean;
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

		hasPid(pid: number): boolean {
			return byPid.has(pid);
		},

		reassign(prevRunId: string, newRunId: string): void {
			const process = byRunId.get(prevRunId);
			if (process === undefined) {
				throw new Error(`Process with runId ${prevRunId} not found in registry`);
			}
			byRunId.delete(prevRunId);
			byRunId.set(newRunId, process);
			// Process runId property is read-only, but we only map it by newRunId.
			// Actually we need to make sure the process has its runId updated if needed.
			// Let's proxy or redefine the runId property if necessary, or just rely on the map.
			// Since JavaScript allows redefining:
			Object.defineProperty(process, 'runId', { value: newRunId, writable: false, configurable: true });
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
