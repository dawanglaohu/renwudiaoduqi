import { describe, expect, it } from 'vitest';
import { areSpecsIdentical, resolveLaunchSpec } from '../src/launch-spec.ts';

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
			}),
		).toThrow('Desktop executable path must be absolute');

		expect(() =>
			resolveLaunchSpec({
				currentExe: 'C:\\Program Files\\Scheduler\\scheduler.exe',
				resourceDir: './resources',
			}),
		).toThrow('Desktop resource directory must be absolute');
	});

	it('rejects relative custom daemon path', () => {
		expect(() =>
			resolveLaunchSpec({
				currentExe: '/opt/scheduler/bin/scheduler',
				resourceDir: '/opt/scheduler/lib',
				customDaemonPath: 'daemon',
			}),
		).toThrow('Invalid launch specification');
	});

	it('areSpecsIdentical compares fields field-by-field', () => {
		const specA = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			customArguments: ['--foo'],
			hostPlatform: 'linux',
		});

		const specB = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			customArguments: ['--foo'],
			hostPlatform: 'linux',
		});

		const specC = resolveLaunchSpec({
			currentExe: '/opt/scheduler/bin/scheduler',
			resourceDir: '/opt/scheduler/lib',
			customArguments: ['--bar'],
			hostPlatform: 'linux',
		});

		expect(areSpecsIdentical(specA, specB)).toBe(true);
		expect(areSpecsIdentical(specA, specC)).toBe(false);
	});
});
