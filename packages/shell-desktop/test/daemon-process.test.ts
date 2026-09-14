import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { launchDaemon } from '../src/daemon-process.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';

describe('desktop daemon-process (AC 2, E-146, E-209)', () => {
	it('launches process with shell: false and exact arguments', () => {
		const spec = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			customArguments: ['--port', '7817'],
			hostPlatform: 'linux',
		});

		const unrefMock = vi.fn();
		const mockSpawn = vi.fn().mockReturnValue({
			pid: 12345,
			unref: unrefMock,
		} as unknown as ChildProcess);

		const result = launchDaemon(spec, { spawn: mockSpawn });

		expect(result.success).toBe(true);
		expect(result.pid).toBe(12345);
		expect(unrefMock).toHaveBeenCalled();
		expect(mockSpawn).toHaveBeenCalledWith('/opt/scheduler/lib/daemon', ['--port', '7817'], {
			cwd: '/opt/scheduler/lib',
			shell: false,
			windowsHide: true,
			detached: true,
			stdio: 'ignore',
		});
	});

	it('returns structured failure when spawn throws without uncaught exceptions', () => {
		const spec = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			hostPlatform: 'linux',
		});

		const mockSpawn = vi.fn().mockImplementation(() => {
			throw new Error('ENOENT: executable not found');
		});

		const result = launchDaemon(spec, { spawn: mockSpawn });

		expect(result.success).toBe(false);
		expect(result.error).toContain('ENOENT');
		expect(result.pid).toBeUndefined();
	});
});
