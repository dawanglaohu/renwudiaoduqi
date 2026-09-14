import { describe, expect, it, vi } from 'vitest';
import * as launchSpecModule from '../src/launch-spec.ts';
import { createDesktopStartupContext, resolveLaunchSpec } from '../src/launch-spec.ts';

describe('desktop launch-spec (AC 2, E-146, E-209)', () => {
	it('resolves valid frozen launch spec with absolute paths on Windows', () => {
		const spec = resolveLaunchSpec({
			currentExe: 'C:\\Program Files\\Scheduler\\scheduler.exe',
			resourceDir: 'C:\\Program Files\\Scheduler\\resources',
			hostPlatform: 'win32',
		});

		expect(spec.file).toBe('C:\\Program Files\\Scheduler\\resources\\daemon.exe');
		expect(spec.cwd).toBe('C:\\Program Files\\Scheduler\\resources');
		expect(spec.args).toEqual([]);
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.args)).toBe(true);
	});

	it('resolves valid frozen launch spec with absolute paths on POSIX', () => {
		const spec = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			hostPlatform: 'linux',
		});

		expect(spec.file).toBe('/opt/scheduler/lib/daemon');
		expect(spec.cwd).toBe('/opt/scheduler/lib');
		expect(spec.args).toEqual([]);
		expect(Object.isFrozen(spec)).toBe(true);
	});

	it('accepts custom daemon path and arguments', () => {
		const spec = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			customDaemonPath: '/usr/local/bin/custom-daemon',
			customArguments: ['--port', '7817'],
			hostPlatform: 'linux',
		});

		expect(spec.file).toBe('/usr/local/bin/custom-daemon');
		expect(spec.args).toEqual(['--port', '7817']);
	});

	it('rejects relative currentExe or resourceDir', () => {
		expect(() =>
			resolveLaunchSpec({
				currentExe: 'relative/scheduler.exe',
				resourceDir: 'C:\\Program Files\\Scheduler',
				hostPlatform: 'win32',
			}),
		).toThrow('Desktop executable path must be absolute');

		expect(() =>
			resolveLaunchSpec({
				currentExe: 'C:\\Program Files\\Scheduler\\scheduler.exe',
				resourceDir: './resources',
				hostPlatform: 'win32',
			}),
		).toThrow('Desktop resource directory must be absolute');
	});

	it('rejects relative custom daemon path', () => {
		expect(() =>
			resolveLaunchSpec({
				currentExe: '/opt/scheduler/bin/scheduler',
				resourceDir: '/opt/scheduler/lib',
				customDaemonPath: 'daemon',
				hostPlatform: 'linux',
			}),
		).toThrow('Invalid launch specification');
	});

	it('asserts that areSpecsIdentical is removed and shell does not have duplicate comparison (R6)', () => {
		expect((launchSpecModule as Record<string, unknown>).areSpecsIdentical).toBeUndefined();
	});

	it('resolves startup path with spaces and Unicode, sharing identical frozen spec between button and autostart (R4, AC 2, E-209)', async () => {
		let autostartReceivedSpec: unknown = null;
		const mockAdapter = {
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { registered: false, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({ ok: true, value: null }),
			unregister: vi.fn().mockResolvedValue({ ok: true, value: null }),
			manualStartCommand: vi.fn().mockReturnValue(''),
			manualUnregisterCommand: '',
		};

		const context = createDesktopStartupContext({
			currentExe: 'C:\\Program Files (x86)\\调度器 任务中心\\app.exe',
			resourceDir: 'C:\\Program Files (x86)\\调度器 任务中心\\resources',
			hostPlatform: 'win32',
			customArguments: ['--mode', 'background'],
			autostartAdapter: mockAdapter,
			autostartSync: async (opts) => {
				autostartReceivedSpec = opts.spec;
				return { outcome: 'registered', registered: true };
			},
		});

		// 1. File and cwd must be absolute paths
		expect(context.spec.file).toBe(
			'C:\\Program Files (x86)\\调度器 任务中心\\resources\\daemon.exe',
		);
		expect(context.spec.cwd).toBe('C:\\Program Files (x86)\\调度器 任务中心\\resources');

		// 2. Args must be preserved as-is
		expect(context.spec.args).toEqual(['--mode', 'background']);

		// 3. Spec is frozen
		expect(Object.isFrozen(context.spec)).toBe(true);

		// 4. Button controller and autostart receive the EXACT SAME frozen object reference
		expect(context.connectionController.spec).toBe(context.spec);

		await context.autostartOutcomePromise;
		expect(autostartReceivedSpec).toBe(context.spec);
	});
});
