import { describe, expect, it, vi } from 'vitest';
import { buildDshLaunchSpec } from '../../src/adapters/dsh/build-launch-spec.ts';
import type { CommandRunnerParams } from '../../src/adapters/probe.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import type { AgentRegistry } from '../../src/config/registry.ts';
import type { ExecutableFileSystem } from '../../src/platform/contract.ts';
import { windowsExecutableCandidatePaths } from '../../src/platform/windows.ts';
import type { LaunchSpec, ManagedProcess, SpawnManagedOptions } from '../../src/proc/spawn.ts';
import { createAgentService } from '../../src/service/agents.ts';

const fileSystem: ExecutableFileSystem = {
	stat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
	lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
	realpath: async (path) => path,
	readlink: async (path) => path,
	access: async () => undefined,
};

function registry(execPath: string): AgentRegistry {
	return {
		getSnapshot: () => ({
			generation: 1,
			fingerprint: 'dsh-current',
			agents: { dsh: { ...BUILT_IN_AGENT_DEFAULTS.dsh, execPath, isEnabled: true } },
			builtInDefaults: BUILT_IN_AGENT_DEFAULTS,
			storedDefaults: BUILT_IN_AGENT_DEFAULTS,
			userOverrides: {},
			defaultUpdates: [],
		}),
		start: vi.fn(),
		stop: vi.fn(),
	} as unknown as AgentRegistry;
}

describe('DSH desktop headless CLI compatibility', () => {
	it('discovers the packaged Windows launcher outside PATH', () => {
		expect(
			windowsExecutableCandidatePaths('dsh', { platform: 'win32', homedir: 'C:\\Users\\tester' }),
		).toContain('C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd');
	});

	it('defaults to a discoverable CLI and inherits the native model selection', () => {
		expect(BUILT_IN_AGENT_DEFAULTS.dsh.execPath).toBe('dsh');
		expect(BUILT_IN_AGENT_DEFAULTS.dsh.defaultModel).toBeNull();
		expect(BUILT_IN_AGENT_DEFAULTS.dsh.argsTemplate).toEqual(['--profile', 'headless']);
		const spec = buildDshLaunchSpec({
			runId: 'dsh-default',
			cwd: '/workspace',
			prompt: 'Reply OK',
		});
		expect(spec.file).toBe('dsh');
		expect(spec.args).toEqual(['--profile', 'headless', 'Reply OK']);
	});

	it('rejects an explicit model rather than passing an unsupported flag or ignoring the selection', () => {
		expect(() =>
			buildDshLaunchSpec({ runId: 'dsh-model', cwd: '/workspace', model: 'deepseek-chat' }),
		).toThrow(/model.*DeepSeek Harness/i);
	});

	it('wraps the Windows smoke launcher through the same command processor as version probing', async () => {
		const runner = vi.fn(async (_params: CommandRunnerParams) => ({
			ok: true,
			exitCode: 0,
			stdout: '0.2.0-rc.2',
			stderr: '',
		}));
		const service = createAgentService({
			registry: registry(
				'D:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
			),
			hostInputs: { platform: 'win32', homedir: 'C:\\Users\\tester' },
			fileSystem,
			commandRunner: runner,
		});
		expect((await service.getAgent('dsh'))?.isAvailable).toBe(true);
		expect(runner).toHaveBeenCalledTimes(2);
		const smoke = runner.mock.calls[1]?.[0] as unknown as { file: string; args: string[] };
		expect(smoke.file).toBe('C:\\Windows\\System32\\cmd.exe');
		expect(smoke.args.join(' ')).toContain('headless');
		await service.stop();
	});

	it('runs the smoke contract on the production spawn path without an injected command runner', async () => {
		const spawn = vi.fn((spec: LaunchSpec, options: SpawnManagedOptions) => {
			queueMicrotask(() => {
				const versionProbe = spec.args.includes('--version');
				if (versionProbe)
					options.onRaw?.({ text: 'dsh 0.2.0-rc.2' } as Parameters<
						NonNullable<SpawnManagedOptions['onRaw']>
					>[0]);
				options.onExit?.({
					runId: spec.runId,
					pid: 1,
					exitCode: versionProbe ? 0 : 1,
					signal: null,
					reason: 'exited',
				});
			});
			return { kill: vi.fn() } as unknown as ManagedProcess;
		});
		const service = createAgentService({
			registry: registry('/usr/bin/dsh'),
			hostInputs: { platform: 'linux', homedir: '/home/tester' },
			fileSystem,
			spawnManagedFn: spawn,
		});
		const dto = await service.getAgent('dsh');
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(dto?.isAvailable).toBe(false);
		expect(dto?.unavailableReason).toContain('non-zero exit code: 1');
		await expect(service.assertCanDispatch('dsh')).rejects.toThrow();
		await service.stop();
	});
});
