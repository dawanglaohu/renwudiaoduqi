import { describe, expect, it } from 'vitest';
import { createLogIndexRepairJob } from '../../src/jobs/log-index-repair.ts';
import type { LogstoreService, RepairRunReport } from '../../src/service/logstore.ts';

function makeService(
	reports: () => readonly RepairRunReport[],
	state: { calls: string[] },
): LogstoreService {
	const base: Partial<LogstoreService> = {
		repairAll: async () => {
			state.calls.push('repairAll');
			return reports();
		},
	};
	return base as LogstoreService;
}

describe('log-index-repair job (R2)', () => {
	it('start runs once and captures exceptions as logged failures, not unhandled rejections', async () => {
		const state: { calls: string[] } = { calls: [] };
		const failures: unknown[] = [];
		const service = makeService(() => [], state);
		const job = createLogIndexRepairJob({
			service,
			logFailure: (e) => failures.push(e),
		});
		expect(job.name).toBe('log-index-repair');
		job.start();
		await job.stop();
		expect(state.calls).toEqual(['repairAll']);
		expect(failures).toHaveLength(0);
	});

	it('captures a throwing repairAll as a logged failure', async () => {
		const failures: unknown[] = [];
		const serviceThrowing = {
			repairAll: async () => {
				throw new Error('disk gone');
			},
		} as unknown as LogstoreService;
		const job = createLogIndexRepairJob({
			service: serviceThrowing,
			logFailure: (e) => failures.push(e),
		});
		job.start();
		await job.stop();
		expect(failures).toHaveLength(1);
	});

	it('start is non-reentrant: a second start while running does not trigger a second repairAll', async () => {
		const holder: { release?: () => void } = {};
		const gate = new Promise<void>((resolve) => {
			holder.release = resolve;
		});
		const state: { calls: string[] } = { calls: [] };
		const repairAllOnly = {
			repairAll: async () => {
				state.calls.push('repairAll');
				await gate;
				return [] as readonly RepairRunReport[];
			},
			getWriter: () => {
				throw new Error('unused');
			},
			closeWriter: async () => {},
			appendRaw: async () => {
				throw new Error('unused');
			},
			appendEvent: async () => {
				throw new Error('unused');
			},
			readEventsPage: async () => {
				throw new Error('unused');
			},
			repairRun: async () => ({ runId: 'x', indexedLines: 0, errors: [] }),
		};
		const job = createLogIndexRepairJob({ service: repairAllOnly, logFailure: () => {} });
		job.start();
		job.start(); // second start must be ignored
		holder.release?.();
		await job.stop();
		expect(state.calls).toEqual(['repairAll']);
	});

	it('runOnce returns reports', async () => {
		const state: { calls: string[] } = { calls: [] };
		const service = makeService(() => [{ runId: 'run-1', indexedLines: 3, errors: [] }], state);
		const job = createLogIndexRepairJob({ service, logFailure: () => {} });
		const reports = await job.runOnce();
		expect(reports).toHaveLength(1);
		expect(reports[0]?.indexedLines).toBe(3);
	});

	it('stop() waits for the in-flight execution to finish', async () => {
		const holder: { release?: () => void } = {};
		const gate = new Promise<void>((resolve) => {
			holder.release = resolve;
		});
		let finished = false;
		const stopService = {
			repairAll: async () => {
				await gate;
				finished = true;
				return [] as readonly RepairRunReport[];
			},
			getWriter: () => {
				throw new Error('unused');
			},
			closeWriter: async () => {},
			appendRaw: async () => {
				throw new Error('unused');
			},
			appendEvent: async () => {
				throw new Error('unused');
			},
			readEventsPage: async () => {
				throw new Error('unused');
			},
			repairRun: async () => ({ runId: 'x', indexedLines: 0, errors: [] }),
		};
		const job = createLogIndexRepairJob({ service: stopService, logFailure: () => {} });
		job.start();
		const stopPromise = job.stop();
		let resolved = false;
		void stopPromise.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false); // still waiting
		holder.release?.();
		await stopPromise;
		expect(finished).toBe(true);
	});
});
