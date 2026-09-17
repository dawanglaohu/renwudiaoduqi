import type { ManagedProcess } from './spawn.ts';

export interface ProcessRegistry {
	register(process: ManagedProcess): void;
	get(runId: string): ManagedProcess | undefined;
	getByPid(pid: number): ManagedProcess | undefined;
	has(runId: string): boolean;
	hasPid(pid: number): boolean;
	/** 进程换绑：第 N 轮的活进程继续服务第 N+1 轮（E-304 的 reply 分支）。 */
	reassign(prevRunId: string, newRunId: string): void;
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
			// ManagedProcess 是只读对象：用带新 runId 的视图替换注册项，进程本身与 pid 不变。
			const rebound: ManagedProcess = { ...process, runId: newRunId };
			byRunId.delete(prevRunId);
			byRunId.set(newRunId, rebound);
			if (rebound.pid > 0) {
				byPid.set(rebound.pid, rebound);
			}
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
