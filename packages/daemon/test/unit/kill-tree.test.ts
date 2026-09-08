import { describe, expect, it, vi } from 'vitest';
import type {
	KillTreeAttemptResult,
	KillTreeEvent,
	KillTreeProcessOps,
} from '../../src/platform/kill-tree-contract.ts';
import { posixKillTree } from '../../src/platform/kill-tree-posix.ts';
import { windowsKillTree } from '../../src/platform/windows.ts';

function processOps(overrides: Partial<KillTreeProcessOps> = {}): KillTreeProcessOps {
	return {
		now: () => '2026-09-07T00:00:00.000Z',
		wait: vi.fn(async () => undefined),
		taskkill: vi.fn(async () => 'still-running' as const),
		signalGroup: vi.fn(() => 'still-running' as const),
		probeTree: vi.fn(async () => 'still-running' as const),
		probeGroup: vi.fn(() => 'still-running' as const),
		...overrides,
	};
}

describe('POSIX killTree (E-119)', () => {
	it('stops after SIGTERM when the group exits during the grace period', async () => {
		const ops = processOps({ probeGroup: vi.fn(() => 'terminated' as const) });
		const events: KillTreeEvent[] = [];
		const result = await posixKillTree(4321, ops, { emit: (event) => events.push(event) });

		expect(ops.signalGroup).toHaveBeenCalledTimes(1);
		expect(ops.signalGroup).toHaveBeenCalledWith(4321, 'SIGTERM');
		expect(ops.wait).toHaveBeenCalledWith(3000);
		expect(result.outcome).toBe('terminated');
		expect(events.map((event) => event.phase)).toEqual(['attempt', 'outcome']);
	});

	it('SIGKILLs only when the group remains alive after the grace period', async () => {
		const results: KillTreeAttemptResult[] = ['still-running', 'terminated'];
		const ops = processOps({ signalGroup: vi.fn(() => results.shift() ?? 'terminated') });
		const result = await posixKillTree(4322, ops);

		expect(ops.signalGroup).toHaveBeenNthCalledWith(1, 4322, 'SIGTERM');
		expect(ops.signalGroup).toHaveBeenNthCalledWith(2, 4322, 'SIGKILL');
		expect(result.attempts.map((attempt) => attempt.method)).toEqual(['sigterm', 'sigkill']);
	});

	it('reports ownership failures without escalation', async () => {
		const ops = processOps({ signalGroup: vi.fn(() => 'not-process-owner' as const) });
		const result = await posixKillTree(4323, ops);
		expect(result.outcome).toBe('not-process-owner');
		expect(ops.wait).not.toHaveBeenCalled();
	});
});

describe('Windows killTree (E-119)', () => {
	it('runs taskkill /T, waits, probes, then avoids /F when the tree exited', async () => {
		const ops = processOps({ probeTree: vi.fn(async () => 'terminated' as const) });
		const result = await windowsKillTree(99, ops);

		expect(ops.taskkill).toHaveBeenCalledTimes(1);
		expect(ops.taskkill).toHaveBeenCalledWith(['/PID', '99', '/T']);
		expect(ops.wait).toHaveBeenCalledWith(3000);
		expect(result.outcome).toBe('terminated');
	});

	it('adds /F only when the process tree survives the probe', async () => {
		const results: KillTreeAttemptResult[] = ['still-running', 'terminated'];
		const ops = processOps({ taskkill: vi.fn(async () => results.shift() ?? 'terminated') });
		const result = await windowsKillTree(100, ops);

		expect(ops.taskkill).toHaveBeenNthCalledWith(1, ['/PID', '100', '/T']);
		expect(ops.taskkill).toHaveBeenNthCalledWith(2, ['/PID', '100', '/T', '/F']);
		expect(result.attempts.map((attempt) => attempt.method)).toEqual([
			'taskkill-soft',
			'taskkill-force',
		]);
	});
});
