import { describe, expect, it, vi } from 'vitest';
import type { KillTreeEvent } from '../../src/platform/kill-tree-contract.ts';
import { posixKillTree } from '../../src/platform/kill-tree-posix.ts';

if (process.platform === 'win32') {
	throw new Error('posix kill-tree tests must not run on Windows');
}

describe('posix killTree (E-119)', () => {
	it('SIGTERMs a group that honours it and stops after one attempt', async () => {
		const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
			throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
		});
		const events: KillTreeEvent[] = [];
		const result = await posixKillTree(4321, { emit: (event) => events.push(event) });
		killSpy.mockRestore();
		expect(result.outcome).toBe('terminated');
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0]?.method).toBe('sigterm');
		expect(events.filter((event) => event.phase === 'attempt')).toHaveLength(1);
		expect(events.some((event) => event.phase === 'outcome')).toBe(true);
	});

	it('SIGKILLs a group that ignores SIGTERM after the grace window', async () => {
		const killSpy = vi
			.spyOn(process, 'kill')
			.mockImplementationOnce(() => true)
			.mockImplementationOnce(() => {
				throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
			});
		const events: KillTreeEvent[] = [];
		const result = await posixKillTree(4322, {
			graceMs: 5,
			emit: (event) => events.push(event),
		});
		killSpy.mockRestore();
		expect(result.outcome).toBe('terminated');
		expect(result.attempts.map((attempt) => attempt.method)).toEqual(['sigterm', 'sigkill']);
		expect(result.attempts[0]?.result).toBe('still-running');
		expect(result.attempts[1]?.result).toBe('terminated');
		expect(events[0]?.phase).toBe('attempt');
	});

	it('treats EPERM as not-process-owner without escalating', async () => {
		const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
			throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
		});
		const result = await posixKillTree(4323, { graceMs: 5 });
		killSpy.mockRestore();
		expect(result.outcome).toBe('not-process-owner');
		expect(result.attempts).toHaveLength(1);
	});

	it('reports survived when both stages leave the tree running', async () => {
		const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
		const result = await posixKillTree(4324, { graceMs: 5 });
		killSpy.mockRestore();
		expect(result.outcome).toBe('survived');
		expect(result.attempts).toHaveLength(2);
	});
});
