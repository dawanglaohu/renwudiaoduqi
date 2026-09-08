import { posix, win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
	AutostartDependencies,
	AutostartFileSystem,
	CommandResult,
} from '../../src/platform/autostart-contract.ts';
import { createPlatformAdapter } from '../../src/platform/host.ts';

const SPEC = Object.freeze({
	file: '/opt/Agent Scheduler/node',
	args: Object.freeze([
		'/opt/Agent Scheduler/daemon.js',
		'',
		'space value',
		'值 & two',
		'quote"value',
		'trailing\\',
	]),
	cwd: '/opt/Agent Scheduler',
});

function harness(platform: 'win32' | 'darwin' | 'linux') {
	const files = new Map<string, string>();
	const tasks = new Map<string, string>();
	const launchAgents = new Set<string>();
	const systemdUnits = new Set<string>();
	const fileSystem: AutostartFileSystem = {
		makeDirectory: vi.fn(async () => undefined),
		readTextFile: vi.fn(async (path) => {
			const value = files.get(path);
			if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return value;
		}),
		writeTextFile: vi.fn(async (path, content) => {
			files.set(path, content);
		}),
		removeFile: vi.fn(async (path) => {
			if (!files.delete(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}),
	};
	const runCommand = vi.fn(
		async (file: string, args: readonly string[]): Promise<CommandResult> => {
			if (file === 'schtasks.exe') {
				const taskName = args[args.indexOf('/TN') + 1] ?? '';
				if (args.includes('/Query')) {
					const xml = tasks.get(taskName);
					return xml === undefined
						? { ok: false, kind: 'not-found', code: 1, stdout: '', stderr: '' }
						: { ok: true, stdout: xml, stderr: '' };
				}
				if (args.includes('/Create')) {
					const xmlPath = args[args.indexOf('/XML') + 1] ?? '';
					tasks.set(taskName, files.get(xmlPath) ?? '');
					return { ok: true, stdout: '', stderr: '' };
				}
				tasks.delete(taskName);
				return { ok: true, stdout: '', stderr: '' };
			}
			if (file === 'launchctl') {
				const value = args.at(-1) ?? '';
				if (args.includes('list')) {
					return launchAgents.has(value)
						? { ok: true, stdout: '', stderr: '' }
						: { ok: false, kind: 'not-found', code: 113, stdout: '', stderr: '' };
				}
				if (args.includes('load')) {
					launchAgents.add('agent-scheduler-test');
					return { ok: true, stdout: '', stderr: '' };
				}
				return launchAgents.delete('agent-scheduler-test')
					? { ok: true, stdout: '', stderr: '' }
					: { ok: false, kind: 'not-found', code: 113, stdout: '', stderr: '' };
			}
			if (file === 'systemctl') {
				const unit = args.at(-1) ?? '';
				if (args.includes('is-enabled')) {
					return systemdUnits.has(unit)
						? { ok: true, stdout: 'enabled', stderr: '' }
						: { ok: false, kind: 'not-found', code: 1, stdout: 'disabled', stderr: '' };
				}
				if (args.includes('enable')) systemdUnits.add(unit);
				if (args.includes('disable') && !systemdUnits.delete(unit)) {
					return { ok: false, kind: 'not-found', code: 1, stdout: '', stderr: '' };
				}
				return { ok: true, stdout: '', stderr: '' };
			}
			return { ok: true, stdout: '', stderr: '' };
		},
	);
	const dependencies: AutostartDependencies = {
		files: fileSystem,
		runCommand,
		temporaryDirectory: platform === 'win32' ? 'C:\\Temp\\agsched' : '/tmp/agsched',
	};
	const host =
		platform === 'win32'
			? { homedir: 'C:\\Users\\tester', appData: 'C:\\Users\\tester\\AppData\\Roaming' }
			: { homedir: '/home/tester', xdgDataHome: '/home/tester/.local/share' };
	const result = createPlatformAdapter(platform, host, 'agent-scheduler-test', dependencies);
	if (!result.ok) throw new Error(result.error.message);
	return { adapter: result.value, files, tasks, runCommand };
}

describe.each(['win32', 'darwin', 'linux'] as const)('%s autostart adapter', (platform) => {
	it('round-trips every launch field, is idempotent, and rewrites changed fields', async () => {
		const { adapter, runCommand } = harness(platform);
		expect(await adapter.autostart.register(SPEC)).toEqual({ ok: true, value: null });
		const registered = await adapter.autostart.status(SPEC);
		expect(registered.ok && registered.value).toMatchObject({
			registered: true,
			matchesSpec: true,
			recordedSpec: SPEC,
		});

		const mutationCount = runCommand.mock.calls.filter(([, args]) =>
			args.some((argument) => ['/Create', 'load', 'enable'].includes(argument)),
		).length;
		expect(await adapter.autostart.register(SPEC)).toEqual({ ok: true, value: null });
		expect(
			runCommand.mock.calls.filter(([, args]) =>
				args.some((argument) => ['/Create', 'load', 'enable'].includes(argument)),
			).length,
		).toBe(mutationCount);

		const changedSpecs = [
			Object.freeze({ ...SPEC, file: `${SPEC.file}-moved` }),
			Object.freeze({ ...SPEC, args: Object.freeze([...SPEC.args, '--moved']) }),
			Object.freeze({ ...SPEC, cwd: `${SPEC.cwd}/moved` }),
		];
		for (const changed of changedSpecs) {
			expect(await adapter.autostart.register(changed)).toEqual({ ok: true, value: null });
			const rewritten = await adapter.autostart.status(changed);
			expect(rewritten.ok && rewritten.value.matchesSpec).toBe(true);
		}
		expect(await adapter.autostart.unregister()).toEqual({ ok: true, value: null });
	});

	it('does not let the embedded spec marker hide tampered native fields', async () => {
		const { adapter, files, tasks } = harness(platform);
		expect(await adapter.autostart.register(SPEC)).toEqual({ ok: true, value: null });
		if (platform === 'win32') {
			const [taskName, xml] = [...tasks.entries()][0] ?? [];
			if (taskName !== undefined && xml !== undefined) {
				tasks.set(taskName, xml.replace('<Command>', '<Command>C:\\tampered.exe'));
			}
		} else {
			const [path, content] = [...files.entries()][0] ?? [];
			if (path !== undefined && content !== undefined) {
				files.set(path, content.replace(SPEC.file, '/tampered/program'));
			}
		}
		const status = await adapter.autostart.status(SPEC);
		expect(status.ok && status.value.matchesSpec).toBe(false);
	});

	it('returns a platform-copyable manual start command with registration failures', async () => {
		const { adapter, runCommand } = harness(platform);
		runCommand.mockResolvedValue({
			ok: false,
			kind: 'denied',
			code: 1,
			stdout: '',
			stderr: 'denied',
		});
		const result = await adapter.autostart.register(SPEC);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.details.manualStartCommand).toBe(
			adapter.autostart.manualStartCommand(SPEC),
		);
		expect(result.error.details.manualStartCommand).toContain(SPEC.file);
	});
});

it('rolls back a partially failed systemd enable operation', async () => {
	const files = new Map<string, string>();
	const fileSystem: AutostartFileSystem = {
		makeDirectory: vi.fn(async () => undefined),
		readTextFile: vi.fn(async (path) => {
			const content = files.get(path);
			if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return content;
		}),
		writeTextFile: vi.fn(async (path, content) => {
			files.set(path, content);
		}),
		removeFile: vi.fn(async (path) => {
			if (!files.delete(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}),
	};
	const runCommand = vi.fn(
		async (_file: string, args: readonly string[]): Promise<CommandResult> => {
			if (args.includes('is-enabled')) {
				return { ok: false, kind: 'not-found', code: 1, stdout: '', stderr: '' };
			}
			if (args.includes('enable')) {
				return { ok: false, kind: 'denied', code: 1, stdout: '', stderr: 'start failed' };
			}
			return { ok: true, stdout: '', stderr: '' };
		},
	);
	const created = createPlatformAdapter(
		'linux',
		{ homedir: '/home/tester' },
		'agent-scheduler-test',
		{ files: fileSystem, runCommand, temporaryDirectory: '/tmp' },
	);
	expect(created.ok).toBe(true);
	if (!created.ok) return;
	const result = await created.value.autostart.register(SPEC);
	expect(result.ok).toBe(false);
	expect(runCommand.mock.calls.some(([, args]) => args.includes('disable'))).toBe(true);
	expect(files.size).toBe(0);
});

it('preserves the previous LaunchAgent file when unloading a stale job fails', async () => {
	const { adapter, files, runCommand } = harness('darwin');
	expect(await adapter.autostart.register(SPEC)).toEqual({ ok: true, value: null });
	const previousContent = [...files.values()][0];
	const normalCommand = runCommand.getMockImplementation();
	runCommand.mockImplementation(async (file, args) => {
		if (file === 'launchctl' && args.includes('unload')) {
			return { ok: false, kind: 'denied', code: 1, stdout: '', stderr: 'denied' };
		}
		if (normalCommand === undefined) throw new Error('missing command implementation');
		return normalCommand(file, args);
	});
	const moved = Object.freeze({ ...SPEC, cwd: `${SPEC.cwd}/moved` });
	const result = await adapter.autostart.register(moved);
	expect(result.ok).toBe(false);
	expect([...files.values()][0]).toBe(previousContent);
});

it('reports an unavailable systemd user manager even when no unit file exists', async () => {
	const readTextFile = vi.fn(async () => {
		throw Object.assign(new Error('missing'), { code: 'ENOENT' });
	});
	const runCommand = vi.fn(
		async (): Promise<CommandResult> => ({
			ok: false,
			kind: 'unsupported',
			code: 1,
			stdout: '',
			stderr: 'Failed to connect to bus',
		}),
	);
	const created = createPlatformAdapter(
		'linux',
		{ homedir: '/home/tester' },
		'agent-scheduler-test',
		{
			files: {
				makeDirectory: vi.fn(),
				readTextFile,
				writeTextFile: vi.fn(),
				removeFile: vi.fn(),
			},
			runCommand,
			temporaryDirectory: '/tmp',
		},
	);
	expect(created.ok).toBe(true);
	if (!created.ok) return;
	const status = await created.value.autostart.status(SPEC);
	expect(status).toMatchObject({ ok: false, error: { code: 'E_AUTOSTART_UNSUPPORTED' } });
	expect(readTextFile).not.toHaveBeenCalled();
});

it('returns E_PLATFORM_UNSUPPORTED instead of choosing a nearby adapter', () => {
	const dependencies: AutostartDependencies = {
		files: {} as AutostartFileSystem,
		runCommand: vi.fn(),
		temporaryDirectory: '/tmp',
	};
	const result = createPlatformAdapter(
		'freebsd',
		{ homedir: '/home/tester' },
		'test',
		dependencies,
	);
	expect(result).toMatchObject({ ok: false, error: { code: 'E_PLATFORM_UNSUPPORTED' } });
});

it('uses platform-native registration locations', async () => {
	const windows = harness('win32');
	await windows.adapter.autostart.register(SPEC);
	expect([...windows.tasks.keys()]).toEqual(['\\AgentScheduler\\agent-scheduler-test']);

	const darwin = harness('darwin');
	await darwin.adapter.autostart.register(SPEC);
	expect([...darwin.files.keys()]).toContain(
		posix.join('/home/tester', 'Library', 'LaunchAgents', 'agent-scheduler-test.plist'),
	);

	const linux = harness('linux');
	await linux.adapter.autostart.register(SPEC);
	expect([...linux.files.keys()]).toContain(
		posix.join('/home/tester', '.config', 'systemd', 'user', 'agent-scheduler-test.service'),
	);
	expect(win32.isAbsolute('C:\\Temp\\agsched')).toBe(true);
});
