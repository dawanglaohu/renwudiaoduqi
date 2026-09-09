import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

type SpawnFn = typeof import('node:child_process').spawn;
import { AppError } from '../../src/errors/app-error.ts';
import type { KillTreeResult } from '../../src/platform/kill-tree-contract.ts';
import { DEFAULT_ENV_DENYLIST, createProcessEnv } from '../../src/proc/env.ts';
import {
	MAX_LINE_BYTE_LENGTH,
	createLineReader,
	parseJsonLine,
} from '../../src/proc/line-reader.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import {
	AgentProcessError,
	type LaunchSpec,
	type ManagedProcess,
	type ProcessExitResult,
	spawnManaged,
} from '../../src/proc/spawn.ts';
import {
	DEFAULT_CHECK_TIMEOUT_MS,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_STARTUP_TIMEOUT_MS_ACP,
	DEFAULT_STARTUP_TIMEOUT_MS_NATIVE,
	type TimerHandle,
	createProcessTimers,
} from '../../src/proc/timers.ts';

interface MockChildProcess extends EventEmitter {
	pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough;
	kill: (signal?: string) => boolean;
}

function createMockChild(pid = 9876): MockChildProcess {
	const emitter = new EventEmitter() as unknown as MockChildProcess;
	emitter.pid = pid;
	emitter.exitCode = null;
	emitter.signalCode = null;
	emitter.stdout = new PassThrough();
	emitter.stderr = new PassThrough();
	emitter.stdin = new PassThrough();
	emitter.kill = vi.fn((_signal?: string) => true);
	return emitter;
}

interface TestPayload {
	readonly type: string;
	readonly content?: string;
	readonly step?: number;
}

describe('M1-T7 Line Reader (Buffer-based, AC 3, AC 4, E-131, E-141, E-203)', () => {
	it('E-203 & AC 3: strictly slices on 0x0A, strips trailing \\r, and preserves U+2028 without line breaking', () => {
		const reader = createLineReader();

		// U+2028 is Line Separator (UTF-8: E2 80 A8); U+2029 is Paragraph Separator (UTF-8: E2 80 A9)
		const payload = {
			type: 'agent_message_chunk',
			content: 'Line 1\u2028Line 2\u2029Still Same Line!',
		};
		const jsonString = JSON.stringify(payload);
		const rawLineWithCrlf = Buffer.from(`${jsonString}\r\n`, 'utf8');

		const lines = reader.push(rawLineWithCrlf);
		expect(lines).toHaveLength(1);
		const firstLine = lines[0];
		expect(firstLine).toBeDefined();
		if (firstLine === undefined) return;

		expect(firstLine.text).toBe(jsonString);
		expect(firstLine.truncated).toBe(false);
		expect(firstLine.text).toContain('\u2028');
		expect(firstLine.text).toContain('\u2029');

		const parsed = parseJsonLine<TestPayload>(firstLine);
		expect(parsed.isJson).toBe(true);
		expect(parsed.value?.content).toBe('Line 1\u2028Line 2\u2029Still Same Line!');
	});

	it('E-131 & AC 3: strips trailing \\r across chunks and supports mixed LF and CRLF', () => {
		const reader = createLineReader();

		// Chunk 1 ends right after \r, chunk 2 begins with \n
		const chunk1 = Buffer.from('hello\r', 'utf8');
		const chunk2 = Buffer.from('\nworld\nfoo\r\n', 'utf8');

		const lines1 = reader.push(chunk1);
		expect(lines1).toHaveLength(0);

		const lines2 = reader.push(chunk2);
		expect(lines2).toHaveLength(3);
		expect(lines2.map((l) => l.text)).toEqual(['hello', 'world', 'foo']);
		expect(lines2.every((l) => !l.truncated)).toBe(true);
	});

	it('AC 3: correctly handles multi-byte UTF-8 characters split across chunks', () => {
		const reader = createLineReader();

		// "中文" in UTF-8 is E4 B8 AD (中) and E6 96 87 (文)
		const full = Buffer.from('你好世界中文提示词\n', 'utf8');
		const splitAt = 7; // splits inside a multi-byte character
		const chunk1 = full.subarray(0, splitAt);
		const chunk2 = full.subarray(splitAt);

		const l1 = reader.push(chunk1);
		expect(l1).toHaveLength(0);

		const l2 = reader.push(chunk2);
		expect(l2).toHaveLength(1);
		expect(l2[0]?.text).toBe('你好世界中文提示词');
		expect(l2[0]?.truncated).toBe(false);
	});

	it('AC 4 & E-141: truncates a single line exceeding 1 MiB, attaches {truncated, rawByteLen}, and continues searching for next \\n', () => {
		const reader = createLineReader({ maxLineByteLength: 1024 }); // Use 1024 for fast test

		const prefix = 'A'.repeat(1024);
		const excess = 'B'.repeat(500);
		const line1Raw = `${prefix}${excess}\n`;
		const line2Raw = 'clean-line-after-overflow\n';

		const lines = reader.push(Buffer.from(line1Raw + line2Raw, 'utf8'));
		expect(lines).toHaveLength(2);

		const overflowLine = lines[0];
		expect(overflowLine).toBeDefined();
		if (overflowLine === undefined) return;

		expect(overflowLine.truncated).toBe(true);
		expect(overflowLine.text).toBe(prefix);
		expect(overflowLine.rawByteLen).toBe(1024 + 500);

		const nextLine = lines[1];
		expect(nextLine).toBeDefined();
		if (nextLine === undefined) return;

		expect(nextLine.truncated).toBe(false);
		expect(nextLine.text).toBe('clean-line-after-overflow');
		expect(nextLine.rawByteLen).toBe('clean-line-after-overflow'.length);
	});

	it('AC 4 & E-141: bounds buffer memory when streaming multi-megabyte oversized line across chunks', () => {
		const reader = createLineReader({ maxLineByteLength: MAX_LINE_BYTE_LENGTH });

		// Push 500 KiB chunks 5 times (2.5 MiB total) without any newline
		const chunk500k = Buffer.alloc(500 * 1024, 0x61); // 'a'
		for (let i = 0; i < 5; i++) {
			const lines = reader.push(chunk500k);
			expect(lines).toHaveLength(0);
			// Buffered bytes in memory must NEVER exceed 1 MiB!
			expect(reader.bufferedBytes).toBeLessThanOrEqual(MAX_LINE_BYTE_LENGTH);
		}
		expect(reader.isDiscardingExcess).toBe(true);

		// Now push the terminating newline plus a second line
		const terminator = Buffer.from('extra-ending\nnext-line\n', 'utf8');
		const lines = reader.push(terminator);

		expect(lines).toHaveLength(2);
		const line1 = lines[0];
		expect(line1?.truncated).toBe(true);
		expect(line1?.rawByteLen).toBe(500 * 1024 * 5 + 'extra-ending'.length);
		if (line1 !== undefined) {
			expect(Buffer.byteLength(line1.text, 'utf8')).toBe(MAX_LINE_BYTE_LENGTH);
		}

		expect(lines[1]?.truncated).toBe(false);
		expect(lines[1]?.text).toBe('next-line');
	});

	it('flush() delivers trailing bytes without trailing newline', () => {
		const reader = createLineReader();
		reader.push(Buffer.from('incomplete line without newline\r', 'utf8'));
		const flushed = reader.flush();
		expect(flushed).toHaveLength(1);
		expect(flushed[0]?.text).toBe('incomplete line without newline');
		expect(flushed[0]?.truncated).toBe(false);
	});
});

describe('M1-T7 Non-JSON line handling (AC 5, E-140)', () => {
	it('parseJsonLine identifies non-JSON lines and preserves them without throwing', () => {
		const bannerLine = {
			text: '=== Agent CLI v1.2.3 Initializing ===',
			truncated: false,
			rawByteLen: 37,
		};
		const warningLine = {
			text: '[WARN] Deprecated model alias used',
			truncated: false,
			rawByteLen: 34,
		};
		const jsonLine = {
			text: '{"type":"run.started","runId":"run-1"}',
			truncated: false,
			rawByteLen: 39,
		};

		const p1 = parseJsonLine(bannerLine);
		expect(p1.isJson).toBe(false);
		expect(p1.text).toBe('=== Agent CLI v1.2.3 Initializing ===');

		const p2 = parseJsonLine(warningLine);
		expect(p2.isJson).toBe(false);
		expect(p2.text).toBe('[WARN] Deprecated model alias used');

		const p3 = parseJsonLine<TestPayload>(jsonLine);
		expect(p3.isJson).toBe(true);
		expect(p3.value?.type).toBe('run.started');
	});
});

describe('M1-T7 Child Process Environment (AC 6, E-131, E-138, E-270)', () => {
	it('enforces mandatory UTF-8, color disabling, and five git credential disablers', () => {
		const env = createProcessEnv({
			baseEnv: {
				PATH: '/usr/bin:/bin',
				GIT_ASKPASS: '/usr/lib/git-core/git-gui--askpass',
				GIT_TERMINAL_PROMPT: '1',
				LANG: 'zh_CN.GBK',
				NO_COLOR: '0',
				FORCE_COLOR: '1',
			},
			platform: 'linux',
		});

		// 1. Mandatory UTF-8 & color disabling (E-131)
		expect(env.LANG).toBe('en_US.UTF-8');
		expect(env.LC_ALL).toBe('en_US.UTF-8');
		expect(env.NO_COLOR).toBe('1');
		expect(env.FORCE_COLOR).toBe('0');

		// 2. Git credential lock (E-138)
		expect(env.GIT_TERMINAL_PROMPT).toBe('0');
		expect(env.GIT_ASKPASS).toBe('');
		expect(env.GCM_INTERACTIVE).toBe('never');
		expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
		expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');

		// 3. Normal path preserved
		expect(env.PATH).toBe('/usr/bin:/bin');
	});

	it('sets GIT_CONFIG_GLOBAL to NUL on Windows', () => {
		const env = createProcessEnv({
			baseEnv: { PATH: 'C:\\Windows\\system32' },
			platform: 'win32',
		});
		expect(env.GIT_CONFIG_GLOBAL).toBe('NUL');
	});

	it('strips denylisted model override variables (E-37)', () => {
		const env = createProcessEnv({
			platform: 'linux',
			baseEnv: {
				ANTHROPIC_MODEL: 'claude-3-opus-20240229',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-haiku-override',
				ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-3-5-sonnet-override',
				OPENAI_MODEL: 'gpt-4o-mini',
				CUSTOM_VAR: 'preserved-value',
			},
			envDenylist: ['SECRET_TOKEN'],
		});

		for (const key of DEFAULT_ENV_DENYLIST) {
			expect(env[key]).toBeUndefined();
		}
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
		expect(env.SECRET_TOKEN).toBeUndefined();
		expect(env.CUSTOM_VAR).toBe('preserved-value');
	});

	it('locks git credential variables against user overrides', () => {
		const env = createProcessEnv({
			platform: 'linux',
			baseEnv: {},
			envOverrides: {
				GIT_TERMINAL_PROMPT: '1',
				GIT_ASKPASS: 'malicious-askpass',
				GIT_CONFIG_GLOBAL: '/home/user/.gitconfig',
				NO_COLOR: '0',
			},
		});

		expect(env.GIT_TERMINAL_PROMPT).toBe('0');
		expect(env.GIT_ASKPASS).toBe('');
		expect(env.GIT_CONFIG_GLOBAL).not.toBe('/home/user/.gitconfig');
		expect(env.NO_COLOR).toBe('1');
	});
});

describe('M1-T7 Process Timers (E-120, E-190)', () => {
	it('differentiates startup timeout between native (60s) and generic-acp (180s) and defaults checkTimeoutMs to 0 (R4)', () => {
		const nativeTimers = createProcessTimers({ isAcp: false });
		expect(nativeTimers.startupTimeoutMs).toBe(DEFAULT_STARTUP_TIMEOUT_MS_NATIVE); // 60s
		expect(nativeTimers.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS); // 900s
		expect(nativeTimers.hardWallClockMs).toBe(0); // disabled
		expect(nativeTimers.checkTimeoutMs).toBe(0); // R4: default 0 (not armed)

		const customTimers = createProcessTimers({
			timeouts: { checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS },
		});
		expect(customTimers.checkTimeoutMs).toBe(600_000); // 10 min when explicitly set

		const acpTimers = createProcessTimers({ isAcp: true });
		expect(acpTimers.startupTimeoutMs).toBe(DEFAULT_STARTUP_TIMEOUT_MS_ACP); // 180s
	});

	it('disarms startup timer on activity and never kills on idle timeout (E-120)', () => {
		let clockMs = 1000;
		const clock = {
			now: () => new Date(clockMs).toISOString(),
			nowMs: () => clockMs,
		};
		const onStartupTimeout = vi.fn();

		const timers = createProcessTimers({
			clock,
			isAcp: false,
			setTimeoutFn: ((cb: () => void) => {
				return 123 as unknown as TimerHandle;
			}) as unknown as (callback: () => void, ms: number) => TimerHandle,
			clearTimeoutFn: vi.fn(),
			onStartupTimeout,
		});

		timers.armStartupTimer();
		expect(timers.isStartupTimerArmed).toBe(true);

		// First event arrives -> disarm
		timers.disarmStartupTimer();
		expect(timers.isStartupTimerArmed).toBe(false);

		// Advance clock by 1000 seconds (> 900s idle timeout)
		clockMs += 1_000_000;
		expect(timers.isIdleSuspected(clockMs)).toBe(true);
		// Note: proc timer NEVER triggers an auto-kill for idle!
		expect(onStartupTimeout).not.toHaveBeenCalled();
	});
});

describe('M1-T7 Process Registry', () => {
	it('registers, retrieves by runId and pid, and unregisters processes', () => {
		const registry = createProcessRegistry();
		const mockProc = {
			runId: 'run-alpha',
			pid: 54321,
		} as unknown as ManagedProcess;

		registry.register(mockProc);
		expect(registry.size).toBe(1);
		expect(registry.get('run-alpha')).toBe(mockProc);
		expect(registry.getByPid(54321)).toBe(mockProc);
		expect(registry.has('run-alpha')).toBe(true);

		expect(registry.list()).toEqual([mockProc]);

		const removed = registry.unregister('run-alpha');
		expect(removed).toBe(true);
		expect(registry.size).toBe(0);
		expect(registry.get('run-alpha')).toBeUndefined();
		expect(registry.getByPid(54321)).toBeUndefined();
	});
});

describe('M1-T7 spawnManaged Core (AC 1, AC 2, AC 5, E-42, E-119, E-130, E-140)', () => {
	it('AC 1 & E-42: caller passes raw argument array and spawn is ALWAYS shell: false', () => {
		let capturedFile = '';
		let capturedArgs: readonly string[] = [];
		let capturedOptions: SpawnOptions = {};

		const mockChild = createMockChild();
		const fakeSpawn = vi.fn((file: string, args: readonly string[], options: SpawnOptions) => {
			capturedFile = file;
			capturedArgs = args;
			capturedOptions = options;
			return mockChild as unknown as ChildProcess;
		});

		const rawArgs = [
			'--model',
			'claude-3-5-sonnet-20241022',
			'--prompt',
			'echo "hello"; rm -rf /; & calc.exe ^| %PATH% !VAR!',
			'arg with spaces',
			'',
		];

		const spec: LaunchSpec = {
			runId: 'run-shell-test',
			file: '/usr/local/bin/agent-cli',
			args: rawArgs,
			cwd: '/tmp/workspace',
		};

		spawnManaged(spec, {
			platform: 'linux',
			spawnFn: fakeSpawn as unknown as SpawnFn,
		});

		expect(capturedFile).toBe('/usr/local/bin/agent-cli');
		expect(capturedArgs).toEqual(rawArgs);
		expect(capturedOptions.shell).toBe(false);
		expect(capturedOptions.detached).toBe(true); // AC 2: independent process group for POSIX
	});

	it('AC 1: rejects non-array or non-string arguments with E_VALIDATION', () => {
		expect(() => {
			spawnManaged(
				{
					runId: 'run-bad',
					file: '/bin/ls',
					args: 'not-an-array' as unknown as string[],
					cwd: '/tmp',
				},
				{ platform: 'linux' },
			);
		}).toThrowError(/args must be an array/);

		expect(() => {
			spawnManaged(
				{
					runId: '',
					file: '/bin/ls',
					args: [],
					cwd: '/tmp',
				},
				{ platform: 'linux' },
			);
		}).toThrowError(/runId must be a non-empty string/);
	});

	it('R2: rejects non-absolute path or foreign-platform path with E_VALIDATION and details {file, reason}', () => {
		let thrownRelative: unknown;
		try {
			spawnManaged(
				{ runId: 'run-rel', file: 'node', args: [], cwd: '/tmp' },
				{ platform: 'linux' },
			);
		} catch (error) {
			thrownRelative = error;
		}
		expect(thrownRelative).toBeInstanceOf(AppError);
		if (thrownRelative instanceof AppError) {
			expect(thrownRelative.code).toBe('E_VALIDATION');
			expect(thrownRelative.details).toEqual({ file: 'node', reason: 'not-absolute' });
		}

		let thrownForeign: unknown;
		try {
			spawnManaged(
				{ runId: 'run-foreign', file: '/usr/bin/agent', args: [], cwd: 'C:\\repo' },
				{ platform: 'win32' },
			);
		} catch (error) {
			thrownForeign = error;
		}
		expect(thrownForeign).toBeInstanceOf(AppError);
		if (thrownForeign instanceof AppError) {
			expect(thrownForeign.code).toBe('E_VALIDATION');
			expect(thrownForeign.details).toEqual({
				file: '/usr/bin/agent',
				reason: 'foreign-platform-path',
			});
		}
	});

	it('AC 2, E-119, E-130: Windows .cmd/.bat wraps args through ComSpec and sets windowsVerbatimArguments: true', () => {
		let capturedFile = '';
		let capturedArgs: readonly string[] = [];
		let capturedOptions: SpawnOptions = {};

		const mockChild = createMockChild();
		const fakeSpawn = vi.fn((file: string, args: readonly string[], options: SpawnOptions) => {
			capturedFile = file;
			capturedArgs = args;
			capturedOptions = options;
			return mockChild as unknown as ChildProcess;
		});

		const spec: LaunchSpec = {
			runId: 'run-win-cmd',
			file: 'C:\\Users\\admin\\AppData\\Roaming\\npm\\grok.cmd',
			args: ['--worktree', 'C:\\repo with spaces', '--model', 'grok-2'],
			cwd: 'C:\\repo',
			windowsComSpecPath: 'C:\\Windows\\System32\\cmd.exe',
		};

		spawnManaged(spec, {
			platform: 'win32',
			spawnFn: fakeSpawn as unknown as SpawnFn,
		});

		expect(capturedFile).toBe('C:\\Windows\\System32\\cmd.exe');
		expect(capturedArgs[0]).toBe('/d');
		expect(capturedArgs[1]).toBe('/s');
		expect(capturedArgs[2]).toBe('/c');
		// ComSpec command line contains the script and escaped args
		expect(capturedArgs[3]).toContain('C:\\Users\\admin\\AppData\\Roaming\\npm\\grok.cmd');
		expect(capturedOptions.shell).toBe(false);
		expect(capturedOptions.windowsHide).toBe(true);
		expect(capturedOptions.windowsVerbatimArguments).toBe(true); // AC 2
	});

	it('AC 2: Windows .cmd/.bat rejects NUL, CR, or LF with E_VALIDATION and argumentIndex', () => {
		const spec: LaunchSpec = {
			runId: 'run-win-bad-args',
			file: 'C:\\bin\\agent.bat',
			args: ['valid', 'bad\nargument', 'also-valid'],
			cwd: 'C:\\repo',
			windowsComSpecPath: 'C:\\Windows\\System32\\cmd.exe',
		};

		let thrown: unknown;
		try {
			spawnManaged(spec, { platform: 'win32' });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AppError);
		if (thrown instanceof AppError) {
			expect(thrown.code).toBe('E_VALIDATION');
			expect(thrown.details?.argumentIndex).toBe(1);
		}
	});

	it('maps native spawn failures to the registered executable error codes', () => {
		const spawnThrowing = (code: string) =>
			vi.fn(() => {
				const failure = new Error(`spawn ${code}`) as NodeJS.ErrnoException;
				failure.code = code;
				throw failure;
			}) as unknown as SpawnFn;
		const spec: LaunchSpec = { runId: 'run-spawn-fail', file: '/opt/agent', args: [], cwd: '/tmp' };
		const codeFor = (native: string): string => {
			try {
				spawnManaged(spec, { platform: 'linux', spawnFn: spawnThrowing(native) });
			} catch (error) {
				return error instanceof AppError ? error.code : 'not-app-error';
			}
			return 'no-throw';
		};
		expect(codeFor('ENOENT')).toBe('E_AGENT_EXEC_NOT_FOUND');
		expect(codeFor('EACCES')).toBe('E_AGENT_EXEC_NOT_EXECUTABLE');
		expect(codeFor('EPERM')).toBe('E_AGENT_EXEC_NOT_EXECUTABLE');
		expect(codeFor('EMFILE')).toBe('E_INTERNAL');
	});

	it('reports a throwing listener through onError instead of swallowing it', () => {
		const mockChild = createMockChild();
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);
		const reported: Error[] = [];
		const delivered: unknown[] = [];
		spawnManaged(
			{ runId: 'run-listener-throws', file: '/bin/agent', args: [], cwd: '/tmp' },
			{
				platform: 'linux',
				spawnFn: fakeSpawn as unknown as SpawnFn,
				onJson: (parsed) => {
					delivered.push(parsed.value);
					throw new Error('listener bug');
				},
				onError: (error) => reported.push(error),
			},
		);

		mockChild.stdout.write('{"type":"a"}\n{"type":"b"}\n');

		expect(delivered).toEqual([{ type: 'a' }, { type: 'b' }]);
		expect(reported).toHaveLength(2);
		expect(reported[0]).toBeInstanceOf(AppError);
		if (reported[0] instanceof AppError) {
			expect(reported[0].code).toBe('E_INTERNAL');
			expect((reported[0].cause as Error).message).toBe('listener bug');
		}
	});

	it('AC 2 & E-130: Windows native .exe is directly spawned with windowsVerbatimArguments: false', () => {
		let capturedFile = '';
		let capturedArgs: readonly string[] = [];
		let capturedOptions: SpawnOptions = {};

		const mockChild = createMockChild();
		const fakeSpawn = vi.fn((file: string, args: readonly string[], options: SpawnOptions) => {
			capturedFile = file;
			capturedArgs = args;
			capturedOptions = options;
			return mockChild as unknown as ChildProcess;
		});

		const spec: LaunchSpec = {
			runId: 'run-win-exe',
			file: 'C:\\Program Files\\nodejs\\node.exe',
			args: ['script.js', 'arg1'],
			cwd: 'C:\\repo',
		};

		spawnManaged(spec, {
			platform: 'win32',
			spawnFn: fakeSpawn as unknown as SpawnFn,
		});

		expect(capturedFile).toBe('C:\\Program Files\\nodejs\\node.exe');
		expect(capturedArgs).toEqual(['script.js', 'arg1']);
		expect(capturedOptions.windowsVerbatimArguments).toBe(false);
		expect(capturedOptions.windowsHide).toBe(true);
	});

	it('AC 5 & E-140: routes non-JSON lines to raw.log and never interrupts the NDJSON event stream', async () => {
		const mockChild = createMockChild();
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);

		const rawLines: string[] = [];
		const jsonEvents: unknown[] = [];

		const spec: LaunchSpec = {
			runId: 'run-mixed-stream',
			file: '/bin/agent',
			args: [],
			cwd: '/tmp',
		};

		spawnManaged(spec, {
			platform: 'linux',
			spawnFn: fakeSpawn as unknown as SpawnFn,
			onRaw: (line) => rawLines.push(line.text),
			onJson: (parsed) => jsonEvents.push(parsed.value),
		});

		// Push mixed stream: banner -> warning -> valid JSON -> progress bar -> valid JSON
		mockChild.stdout.write('=== Agent CLI v1.0.0 ===\n');
		mockChild.stdout.write('[WARN] Running in non-interactive mode\n');
		mockChild.stdout.write('{"type":"run.started","step":1}\n');
		mockChild.stdout.write('[=========>          ] 50%\n');
		mockChild.stdout.write('{"type":"run.completed","step":2}\n');

		// Stderr also routes to raw.log
		mockChild.stderr.write('stderr diagnostics\n');

		expect(rawLines).toEqual([
			'=== Agent CLI v1.0.0 ===',
			'[WARN] Running in non-interactive mode',
			'{"type":"run.started","step":1}',
			'[=========>          ] 50%',
			'{"type":"run.completed","step":2}',
			'stderr diagnostics',
		]);

		expect(jsonEvents).toEqual([
			{ type: 'run.started', step: 1 },
			{ type: 'run.completed', step: 2 },
		]);
	});

	it('E-119: process tree termination triggers killTree with SIGTERM then SIGKILL on POSIX', async () => {
		const mockChild = createMockChild(7788);
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);
		const killTreeMock = vi.fn(async (_pid, _ops, _options): Promise<KillTreeResult> => {
			return {
				outcome: 'terminated',
				attempts: [
					{
						attempt: 1,
						method: 'sigterm',
						result: 'still-running',
						at: '2026-09-08T00:00:00.000Z',
					},
					{ attempt: 2, method: 'sigkill', result: 'terminated', at: '2026-09-08T00:00:03.000Z' },
				],
			};
		});

		const spec: LaunchSpec = {
			runId: 'run-kill-tree',
			file: '/bin/agent',
			args: [],
			cwd: '/tmp',
		};

		const managed = spawnManaged(spec, {
			platform: 'linux',
			spawnFn: fakeSpawn as unknown as SpawnFn,
			killTree: killTreeMock,
		});

		const killResult = await managed.kill();
		expect(killTreeMock).toHaveBeenCalledTimes(1);
		expect(killTreeMock).toHaveBeenCalledWith(7788, expect.any(Object), undefined);
		expect(killResult.outcome).toBe('terminated');
		expect(killResult.attempts.map((a) => a.method)).toEqual(['sigterm', 'sigkill']);
	});

	it('registers with ProcessRegistry on spawn and unregisters on finalize', async () => {
		const mockChild = createMockChild(9999);
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);
		const registry = createProcessRegistry();

		const spec: LaunchSpec = {
			runId: 'run-reg-lifecycle',
			file: '/bin/agent',
			args: [],
			cwd: '/tmp',
		};

		const managed = spawnManaged(spec, {
			platform: 'linux',
			spawnFn: fakeSpawn as unknown as SpawnFn,
			registry,
		});

		expect(registry.has('run-reg-lifecycle')).toBe(true);
		expect(registry.get('run-reg-lifecycle')).toBe(managed);
		expect(registry.getByPid(9999)).toBe(managed);

		await managed.finalize();

		expect(registry.has('run-reg-lifecycle')).toBe(false);
		expect(registry.get('run-reg-lifecycle')).toBeUndefined();
		expect(managed.isExited).toBe(true);
	});

	it('E-190: startup timeout kills process tree and fires error with E_AGENT_STARTUP_TIMEOUT', async () => {
		const mockChild = createMockChild(1234);
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);
		const killTreeMock = vi.fn(async (_pid, _ops, _options): Promise<KillTreeResult> => {
			return { outcome: 'terminated', attempts: [] };
		});

		let recordedTimeout: Error | undefined;

		const spec: LaunchSpec = {
			runId: 'run-startup-timeout',
			file: '/bin/agent',
			args: [],
			cwd: '/tmp',
			timeouts: { startupTimeoutMs: 10 }, // 10ms timeout
		};

		spawnManaged(spec, {
			platform: 'linux',
			spawnFn: fakeSpawn as unknown as SpawnFn,
			killTree: killTreeMock,
			onError: (err) => {
				recordedTimeout = err;
			},
		});

		// Produce only non-JSON stderr
		mockChild.stderr.write('loading plugin 1...\n');
		mockChild.stderr.write('loading plugin 2...\n');

		// Wait for startup timeout to fire
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(killTreeMock).toHaveBeenCalledTimes(1);
		expect(recordedTimeout).toBeDefined();
		expect(recordedTimeout).toBeInstanceOf(AgentProcessError);
		if (recordedTimeout instanceof AgentProcessError) {
			expect(recordedTimeout.code).toBe('E_AGENT_STARTUP_TIMEOUT');
			expect(recordedTimeout.stderrTail).toContain('loading plugin 1...');
		}
	});

	it('E-42: real Node child process preserves verbatim arguments containing shell metacharacters and Unicode', async () => {
		// Spawn real Node.js process that echos argv back as NDJSON
		// For node -e script, process.argv[0] is node binary, process.argv.slice(1) are the passed arguments
		const script = 'console.log(JSON.stringify({ argv: process.argv.slice(1) }));';
		const trickyArgs = [
			'simple',
			'with spaces and "quotes"',
			'semi;colon & ampersand | pipe',
			'$(echo nested)',
			'Unicode 中文 \u2028 line-separator \u2029 paragraph',
		];

		const jsonEvents: Array<{ readonly argv?: readonly string[] }> = [];
		const spec: LaunchSpec = {
			runId: 'run-real-node-argv',
			file: process.execPath,
			args: ['-e', script, ...trickyArgs],
			cwd: process.cwd(),
		};

		const managed = spawnManaged(spec, {
			platform: process.platform as 'win32' | 'darwin' | 'linux',
			onJson: (parsed) => jsonEvents.push(parsed.value as { readonly argv?: readonly string[] }),
		});

		await new Promise<void>((resolve) => {
			managed.onExit(() => resolve());
		});

		expect(jsonEvents).toHaveLength(1);
		const receivedArgv = jsonEvents[0]?.argv;
		expect(receivedArgv).toEqual(trickyArgs);
	});

	it('stdin writes pass through to child process and exitResult is populated', async () => {
		// Spawn real Node.js process that reads line from stdin and responds
		const script =
			'process.stdin.once("data", (d) => { console.log(JSON.stringify({ echo: d.toString().trim() })); process.exit(0); });';

		const jsonEvents: Array<{ readonly echo?: string }> = [];
		let exitEvent: ProcessExitResult | undefined;

		const spec: LaunchSpec = {
			runId: 'run-real-stdin',
			file: process.execPath,
			args: ['-e', script],
			cwd: process.cwd(),
		};

		const managed = spawnManaged(spec, {
			platform: process.platform as 'win32' | 'darwin' | 'linux',
			onJson: (parsed) => jsonEvents.push(parsed.value as { readonly echo?: string }),
			onExit: (result) => {
				exitEvent = result;
			},
		});

		managed.writeStdin('hello-from-stdin\n');

		await new Promise<void>((resolve) => {
			managed.onExit(() => resolve());
		});

		expect(jsonEvents).toEqual([{ echo: 'hello-from-stdin' }]);
		expect(exitEvent).toBeDefined();
		expect(exitEvent?.exitCode).toBe(0);
		expect(exitEvent?.reason).toBe('exited');
		expect(managed.isExited).toBe(true);
	});

	it('R1: exit does not finalize; allows pending stdout to drain before close triggers finalize', () => {
		const mockChild = createMockChild();
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);
		const registry = createProcessRegistry();
		const jsonEvents: unknown[] = [];
		const exitEvents: ProcessExitResult[] = [];

		const managed = spawnManaged(
			{ runId: 'run-drain-exit-close', file: '/bin/agent', args: [], cwd: '/tmp' },
			{
				platform: 'linux',
				spawnFn: fakeSpawn as unknown as SpawnFn,
				registry,
				exitDrainGraceMs: 500,
				onJson: (p) => jsonEvents.push(p.value),
				onExit: (r) => exitEvents.push(r),
			},
		);

		// Step 1: Write incomplete JSON chunk
		mockChild.stdout.write('{"type":"a"');

		// Step 2: Emit 'exit'
		mockChild.emit('exit', 0, null);

		// Between exit and close: isExited is false, registry still has run, exit not yet fired
		expect(managed.isExited).toBe(false);
		expect(registry.has('run-drain-exit-close')).toBe(true);
		expect(exitEvents).toHaveLength(0);

		// Step 3: Write remaining JSON chunk ending in newline
		mockChild.stdout.write(',"b":1}\n');

		// Step 4: Emit 'close'
		mockChild.emit('close', 0, null);

		// onJson received exactly once
		expect(jsonEvents).toEqual([{ type: 'a', b: 1 }]);
		// onExit triggered once after onJson
		expect(exitEvents).toHaveLength(1);
		expect(exitEvents[0]?.reason).toBe('exited');
		expect(managed.isExited).toBe(true);
		expect(registry.has('run-drain-exit-close')).toBe(false);
	});

	it('R1: child exit without close triggers finalize after fallback timer', async () => {
		const mockChild = createMockChild();
		const fakeSpawn = vi.fn(() => mockChild as unknown as ChildProcess);
		const exitEvents: ProcessExitResult[] = [];

		const managed = spawnManaged(
			{ runId: 'run-drain-timeout', file: '/bin/agent', args: [], cwd: '/tmp' },
			{
				platform: 'linux',
				spawnFn: fakeSpawn as unknown as SpawnFn,
				exitDrainGraceMs: 30,
				onExit: (r) => exitEvents.push(r),
			},
		);

		mockChild.emit('exit', 0, null);
		expect(managed.isExited).toBe(false);
		expect(exitEvents).toHaveLength(0);

		// Wait for fallback timer (30ms) to fire
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(managed.isExited).toBe(true);
		expect(exitEvents).toHaveLength(1);
		expect(exitEvents[0]?.reason).toBe('exited');
	});

	it('R1: startup timeout kills tree: terminated waits for close; survived immediately finalizes', async () => {
		// Case 1: killTree returns 'terminated' -> waits for 'close'
		const mockChild1 = createMockChild(1111);
		const killTreeTerminated = vi.fn(async (): Promise<KillTreeResult> => {
			return {
				outcome: 'terminated',
				attempts: [
					{ attempt: 1, method: 'sigterm', result: 'terminated', at: '2026-09-08T00:00:00.000Z' },
				],
			};
		});
		const exitEvents1: ProcessExitResult[] = [];

		const managed1 = spawnManaged(
			{
				runId: 'run-timeout-terminated',
				file: '/bin/agent',
				args: [],
				cwd: '/tmp',
				timeouts: { startupTimeoutMs: 10 },
			},
			{
				platform: 'linux',
				spawnFn: vi.fn(() => mockChild1 as unknown as ChildProcess) as unknown as SpawnFn,
				killTree: killTreeTerminated,
				onExit: (r) => exitEvents1.push(r),
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(killTreeTerminated).toHaveBeenCalledTimes(1);
		// Still waiting for 'close'
		expect(managed1.isExited).toBe(false);
		expect(exitEvents1).toHaveLength(0);

		// Now emit close
		mockChild1.emit('close', null, 'SIGTERM');
		expect(managed1.isExited).toBe(true);
		expect(exitEvents1).toHaveLength(1);
		expect(exitEvents1[0]?.reason).toBe('startup-timeout');
		expect(exitEvents1[0]?.killTree?.outcome).toBe('terminated');
		expect(exitEvents1[0]?.killTree?.attempts).toHaveLength(1);

		// Case 2: killTree returns 'survived' -> immediately finalizes without waiting for close
		const mockChild2 = createMockChild(2222);
		const killTreeSurvived = vi.fn(async (): Promise<KillTreeResult> => {
			return {
				outcome: 'survived',
				attempts: [
					{
						attempt: 1,
						method: 'sigterm',
						result: 'still-running',
						at: '2026-09-08T00:00:00.000Z',
					},
					{
						attempt: 2,
						method: 'sigkill',
						result: 'still-running',
						at: '2026-09-08T00:00:03.000Z',
					},
				],
			};
		});
		const exitEvents2: ProcessExitResult[] = [];

		const managed2 = spawnManaged(
			{
				runId: 'run-timeout-survived',
				file: '/bin/agent',
				args: [],
				cwd: '/tmp',
				timeouts: { startupTimeoutMs: 10 },
			},
			{
				platform: 'linux',
				spawnFn: vi.fn(() => mockChild2 as unknown as ChildProcess) as unknown as SpawnFn,
				killTree: killTreeSurvived,
				onExit: (r) => exitEvents2.push(r),
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(killTreeSurvived).toHaveBeenCalledTimes(1);
		// Did not wait for close because outcome is survived!
		expect(managed2.isExited).toBe(true);
		expect(exitEvents2).toHaveLength(1);
		expect(exitEvents2[0]?.reason).toBe('startup-timeout');
		expect(exitEvents2[0]?.killTree?.outcome).toBe('survived');
	});

	it('R3: hardWallClockMs expires -> onExit has reason wall-clock-timeout, error is undefined, killTree called once', async () => {
		const mockChild = createMockChild(3333);
		const killTreeMock = vi.fn(async (): Promise<KillTreeResult> => {
			return { outcome: 'survived', attempts: [] };
		});
		const exitEvents: ProcessExitResult[] = [];
		const errors: Error[] = [];

		spawnManaged(
			{
				runId: 'run-hard-timeout',
				file: '/bin/agent',
				args: [],
				cwd: '/tmp',
				timeouts: { hardWallClockMs: 10 },
			},
			{
				platform: 'linux',
				spawnFn: vi.fn(() => mockChild as unknown as ChildProcess) as unknown as SpawnFn,
				killTree: killTreeMock,
				onError: (e) => errors.push(e),
				onExit: (r) => exitEvents.push(r),
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(killTreeMock).toHaveBeenCalledTimes(1);
		expect(errors).toHaveLength(0); // R3: no onError
		expect(exitEvents).toHaveLength(1);
		expect(exitEvents[0]?.reason).toBe('wall-clock-timeout');
		expect(exitEvents[0]?.error).toBeUndefined();
	});

	it('R4: spawnManaged without timeouts does not arm check timer', () => {
		const mockChild = createMockChild();
		const managed = spawnManaged(
			{ runId: 'run-no-check-arm', file: '/bin/agent', args: [], cwd: '/tmp' },
			{
				platform: 'linux',
				spawnFn: vi.fn(() => mockChild as unknown as ChildProcess) as unknown as SpawnFn,
			},
		);

		// Startup timer is 60s default, but checkTimeoutMs is 0 by default (not armed)
		expect(managed.timers.checkTimeoutMs).toBe(0);
	});
});
