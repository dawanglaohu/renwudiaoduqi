import {
	type ChildProcess,
	type SpawnOptions,
	execFile,
	spawn as nodeSpawn,
} from 'node:child_process';
import type { ErrorCode } from '@agent-scheduler/shared/errors/codes';
import { AppError } from '../errors/app-error.ts';
import type { AppendQueue } from '../logstore/append-queue.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import { classifyPathForHost } from '../platform/host.ts';
import type {
	KillTreeOptions,
	KillTreeProcessOps,
	KillTreeResult,
} from '../platform/kill-tree-contract.ts';
import { posixKillTree } from '../platform/kill-tree-posix.ts';
import { comSpec, windowsKillTree, wrapForComSpec } from '../platform/windows.ts';
import { createProcessEnv } from './env.ts';
import {
	type LineReader,
	type ParsedJsonLine,
	type ReadLine,
	createLineReader,
	parseJsonLine,
} from './line-reader.ts';
import type { ProcessRegistry } from './registry.ts';
import {
	type Clock,
	type LaunchTimeouts,
	type ProcessTimerController,
	createProcessTimers,
} from './timers.ts';

export const EXIT_DRAIN_GRACE_MS = 2000;

export class AgentProcessError extends AppError {
	readonly pid?: number;
	readonly exitCode?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly stderrTail?: string;
	readonly launchSpecId?: string;

	constructor(
		code: ErrorCode,
		message: string,
		context: {
			pid?: number;
			exitCode?: number | null;
			signal?: NodeJS.Signals | null;
			stderrTail?: string;
			launchSpecId?: string;
			cause?: unknown;
			details?: Record<string, unknown>;
		} = {},
	) {
		super(code, message, {
			cause: context.cause,
			details: {
				...context.details,
				...(context.pid !== undefined ? { pid: context.pid } : {}),
				...(context.exitCode !== undefined ? { exitCode: context.exitCode } : {}),
				...(context.signal !== undefined ? { signal: context.signal } : {}),
				...(context.stderrTail !== undefined ? { stderrTail: context.stderrTail } : {}),
				...(context.launchSpecId !== undefined ? { launchSpecId: context.launchSpecId } : {}),
			},
		});
		this.name = 'AgentProcessError';
		this.pid = context.pid;
		this.exitCode = context.exitCode;
		this.signal = context.signal;
		this.stderrTail = context.stderrTail;
		this.launchSpecId = context.launchSpecId;
	}
}

export interface LaunchSpec {
	readonly runId: string;
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly envDenylist?: readonly string[];
	readonly timeouts?: LaunchTimeouts;
	readonly label?: string;
	readonly isAcp?: boolean;
	readonly windowsComSpecPath?: string;
}

export type ProcessExitReason =
	| 'exited'
	| 'spawn-failed'
	| 'startup-timeout'
	| 'wall-clock-timeout'
	| 'check-timeout';

export interface ProcessExitResult {
	readonly runId: string;
	readonly pid: number;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
	readonly killTree?: KillTreeResult;
	readonly reason: ProcessExitReason;
}

export interface ManagedProcess {
	readonly runId: string;
	readonly pid: number;
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly child: ChildProcess;
	readonly stdoutReader: LineReader;
	readonly stderrReader: LineReader;
	readonly timers: ProcessTimerController;
	readonly appendQueue?: AppendQueue;
	readonly isExited: boolean;
	readonly exitResult?: ProcessExitResult;
	readonly stderrTail: string;
	readonly stderrTailLines?: readonly string[];
	attachAppendQueue(queue: AppendQueue): () => void;
	waitForStdinDrain(): Promise<void>;
	onStdinDrain(listener: () => void): () => void;
	writeStdin(data: string | Buffer): boolean;
	onLine(listener: (line: ReadLine) => void): () => void;
	onRaw(listener: (line: ReadLine) => void): () => void;
	onStderr(listener: (line: ReadLine) => void): () => void;
	onJson(listener: (parsed: ParsedJsonLine) => void): () => void;
	onExit(listener: (result: ProcessExitResult) => void): () => void;
	onError(listener: (error: Error) => void): () => void;
	kill(options?: KillTreeOptions): Promise<KillTreeResult>;
	finalize(): Promise<void>;
}

export interface SpawnManagedOptions {
	readonly platform: SupportedPlatform;
	readonly exitDrainGraceMs?: number;
	readonly baseEnv?: Readonly<Record<string, string | undefined>>;
	readonly emptyGitConfigFile?: string;
	readonly spawnFn?: typeof nodeSpawn;
	readonly processOps?: KillTreeProcessOps;
	readonly killTree?: (
		pid: number,
		processOps: KillTreeProcessOps,
		options?: KillTreeOptions,
	) => Promise<KillTreeResult>;
	readonly registry?: ProcessRegistry;
	readonly clock?: Clock;
	readonly appendQueue?: AppendQueue;
	readonly onLine?: (line: ReadLine) => void;
	readonly onRaw?: (line: ReadLine) => void;
	readonly onStderr?: (line: ReadLine) => void;
	readonly onJson?: (parsed: ParsedJsonLine) => void;
	readonly onExit?: (result: ProcessExitResult) => void;
	readonly onError?: (error: Error) => void;
}

const MAX_STDERR_TAIL_LINES = 20;
const MAX_STDERR_LINE_BYTES = 1024;
const MAX_STDERR_TOTAL_BYTES = 8192;

export function spawnManaged(spec: LaunchSpec, options: SpawnManagedOptions): ManagedProcess {
	// 1. Input validation (E-42)
	if (typeof spec.runId !== 'string' || spec.runId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'LaunchSpec runId must be a non-empty string');
	}
	if (typeof spec.file !== 'string' || spec.file.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'LaunchSpec file must be a non-empty string');
	}
	if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string')) {
		throw new AppError('E_VALIDATION', 'LaunchSpec args must be an array of strings');
	}

	const platform = options.platform;

	const classified = classifyPathForHost(spec.file, platform);
	if (!classified.isValidForCurrentPlatform) {
		throw new AppError('E_VALIDATION', `Invalid executable path for ${platform}: ${spec.file}`, {
			details: { file: spec.file, reason: classified.reason },
		});
	}

	// 2. Platform executable resolution (E-119, E-130, E-42)
	const normalizedFile = classified.normalizedPath;
	let targetFile = normalizedFile;
	let targetArgs: readonly string[] = spec.args;
	let windowsVerbatimArguments = false;
	const isCmdBat = platform === 'win32' && /\.(?:cmd|bat)$/i.test(normalizedFile);

	if (isCmdBat) {
		const commandProcessor = spec.windowsComSpecPath ?? comSpec();
		const wrapResult = wrapForComSpec(normalizedFile, spec.args, commandProcessor);
		if (!wrapResult.ok) {
			throw new AppError('E_VALIDATION', wrapResult.error.message, {
				details: wrapResult.error.details as Record<string, unknown>,
			});
		}
		targetFile = wrapResult.launch.file;
		targetArgs = wrapResult.launch.args;
		windowsVerbatimArguments = wrapResult.launch.spawnOptions.windowsVerbatimArguments;
	}

	// 3. Child process environment (E-131, E-138, E-270)
	const env = createProcessEnv({
		platform,
		baseEnv: options.baseEnv,
		envOverrides: spec.envOverrides,
		envDenylist: spec.envDenylist,
		emptyGitConfigFile: options.emptyGitConfigFile,
	});

	// 4. Construct spawn options: ALWAYS shell: false
	const spawnOptions: SpawnOptions = {
		cwd: spec.cwd,
		env,
		shell: false,
		windowsHide: platform === 'win32',
		windowsVerbatimArguments: platform === 'win32' ? windowsVerbatimArguments : undefined,
		detached: platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe'],
	};

	const spawnFn = options.spawnFn ?? nodeSpawn;
	let child: ChildProcess;
	try {
		child = spawnFn(targetFile, [...targetArgs], spawnOptions);
	} catch (cause) {
		throw new AppError(spawnErrorCode(cause), `Failed to spawn executable: ${targetFile}`, {
			cause,
			details: { file: targetFile, args: targetArgs, cwd: spec.cwd },
		});
	}

	const pid = child.pid ?? 0;

	// 5. Line readers for stdout and stderr (E-131, E-140, E-141, E-203, E-348)
	const stdoutReader = createLineReader();
	const stderrReader = createLineReader();
	const stderrTailQueue: string[] = [];

	function pushStderrTail(text: string): void {
		const trimmedLine =
			text.length > MAX_STDERR_LINE_BYTES ? text.slice(0, MAX_STDERR_LINE_BYTES) : text;
		stderrTailQueue.push(trimmedLine);
		while (stderrTailQueue.length > MAX_STDERR_TAIL_LINES) {
			stderrTailQueue.shift();
		}
		let totalLen = stderrTailQueue.reduce((acc, l) => acc + l.length, 0);
		while (totalLen > MAX_STDERR_TOTAL_BYTES && stderrTailQueue.length > 0) {
			const removed = stderrTailQueue.shift();
			if (removed) {
				totalLen -= removed.length;
			}
		}
	}

	const lineListeners = new Set<(line: ReadLine) => void>();
	const rawListeners = new Set<(line: ReadLine) => void>();
	const stderrListeners = new Set<(line: ReadLine) => void>();
	const jsonListeners = new Set<(parsed: ParsedJsonLine) => void>();
	const exitListeners = new Set<(result: ProcessExitResult) => void>();
	const errorListeners = new Set<(error: Error) => void>();

	if (options.onLine) lineListeners.add(options.onLine);
	if (options.onRaw) rawListeners.add(options.onRaw);
	if (options.onStderr) stderrListeners.add(options.onStderr);
	if (options.onJson) jsonListeners.add(options.onJson);
	if (options.onExit) exitListeners.add(options.onExit);
	if (options.onError) errorListeners.add(options.onError);

	// Error listeners are the last resort: their own exceptions propagate.
	function dispatchError(error: Error): void {
		for (const listener of errorListeners) {
			listener(error);
		}
	}

	// A throwing listener must not break the stream, but the failure is reported, never hidden.
	function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
		for (const listener of listeners) {
			try {
				listener(value);
			} catch (cause) {
				dispatchError(new AppError('E_INTERNAL', 'Managed process listener threw', { cause }));
			}
		}
	}

	// 6. Timers (E-190, E-120, E-66)
	const timers = createProcessTimers({
		timeouts: spec.timeouts,
		isAcp: spec.isAcp,
		clock: options.clock,
		onStartupTimeout: () => void handleStartupTimeout(),
		onHardWallClockTimeout: () => void handleHardWallClockTimeout(),
		onCheckTimeout: () => void handleCheckTimeout(),
	});

	let isExited = false;
	// Stays 'exited' until a timeout claims the termination; the first claim wins.
	let exitReason: ProcessExitReason = 'exited';
	let lastKillTreeResult: KillTreeResult | undefined = undefined;
	let exitResult: ProcessExitResult | undefined = undefined;
	let lastProcessError: Error | undefined = undefined;
	let finalizePromise: Promise<void> | null = null;
	let exitDrainTimerId: ReturnType<typeof setTimeout> | undefined = undefined;
	let pendingKill: Promise<KillTreeResult> | null = null;
	const exitDrainGraceMs = options.exitDrainGraceMs ?? EXIT_DRAIN_GRACE_MS;

	async function handleStartupTimeout(): Promise<void> {
		if (isExited || exitReason !== 'exited') return;
		exitReason = 'startup-timeout';
		const error = new AgentProcessError(
			'E_AGENT_STARTUP_TIMEOUT',
			`Agent process timed out before initial event (${timers.startupTimeoutMs}ms)`,
			{
				pid,
				launchSpecId: spec.runId,
				stderrTail: stderrTailQueue.join('\n'),
			},
		);
		lastProcessError = error;
		dispatchError(error);
		const result = await kill();
		if (result.outcome !== 'terminated') {
			void finalize();
		}
	}

	async function handleHardWallClockTimeout(): Promise<void> {
		if (isExited || exitReason !== 'exited') return;
		exitReason = 'wall-clock-timeout';
		const result = await kill();
		if (result.outcome !== 'terminated') {
			void finalize();
		}
	}

	async function handleCheckTimeout(): Promise<void> {
		if (isExited || exitReason !== 'exited') return;
		exitReason = 'check-timeout';
		const result = await kill();
		if (result.outcome !== 'terminated') {
			void finalize();
		}
	}

	// 7. Wire stdout stream data
	if (child.stdout !== null) {
		child.stdout.on('data', (chunk: Buffer) => {
			timers.recordActivity();
			const lines = stdoutReader.push(chunk);
			for (const line of lines) {
				timers.recordActivity();
				notify(rawListeners, line);
				notify(lineListeners, line);

				const parsed = parseJsonLine(line);
				if (parsed.isJson) {
					timers.disarmStartupTimer();
					notify(jsonListeners, parsed);
				}
				// E-140: non-JSON lines remain in raw.log and NEVER interrupt the stream
			}
		});
	}

	// 8. Wire stderr stream data
	if (child.stderr !== null) {
		child.stderr.on('data', (chunk: Buffer) => {
			const lines = stderrReader.push(chunk);
			for (const line of lines) {
				timers.recordActivity();
				pushStderrTail(line.text);
				notify(rawListeners, line);
				notify(stderrListeners, line);
			}
		});
	}

	// 9. Process tree termination implementation (E-119)
	const processOps = options.processOps ?? createDefaultProcessOps(platform);
	const killTreeFn = options.killTree ?? (platform === 'win32' ? windowsKillTree : posixKillTree);

	// The exit record must carry every termination attempt, so an in-flight kill is
	// tracked here and finalize waits for it: SIGTERM usually lands within the grace
	// period, which makes 'close' arrive long before the adapter reports its outcome.
	async function kill(killOptions?: KillTreeOptions): Promise<KillTreeResult> {
		if (pid <= 0) {
			return Object.freeze({ outcome: 'terminated', attempts: Object.freeze([]) });
		}
		const inFlight = killTreeFn(pid, processOps, killOptions).then((result) => {
			lastKillTreeResult = result;
			return result;
		});
		pendingKill = inFlight;
		try {
			return await inFlight;
		} finally {
			if (pendingKill === inFlight) pendingKill = null;
		}
	}

	// 10. Idempotent finalize: reached from 'close', the drain grace after 'exit', a
	// spawn failure, a kill the tree survived, or the caller.
	function finalize(): Promise<void> {
		if (finalizePromise !== null) return finalizePromise;
		finalizePromise = (async () => {
			if (isExited) return;
			isExited = true;

			if (exitDrainTimerId !== undefined) {
				clearTimeout(exitDrainTimerId);
				exitDrainTimerId = undefined;
			}

			if (detachQueue !== undefined) {
				detachQueue();
				detachQueue = undefined;
			}

			timers.clearAll();

			// Flush remaining buffers from line readers
			for (const line of stdoutReader.flush()) {
				timers.recordActivity();
				notify(rawListeners, line);
				notify(lineListeners, line);
				const parsed = parseJsonLine(line);
				if (parsed.isJson) {
					timers.disarmStartupTimer();
					notify(jsonListeners, parsed);
				}
			}

			for (const line of stderrReader.flush()) {
				timers.recordActivity();
				pushStderrTail(line.text);
				notify(rawListeners, line);
				notify(stderrListeners, line);
			}

			if (pendingKill !== null) {
				await pendingKill;
			}

			if (options.registry !== undefined) {
				options.registry.unregister(spec.runId);
			}

			const result: ProcessExitResult = Object.freeze({
				runId: spec.runId,
				pid,
				exitCode: child.exitCode,
				signal: child.signalCode,
				error: lastProcessError,
				killTree: lastKillTreeResult,
				reason: exitReason,
			});
			exitResult = result;
			notify(exitListeners, result);
		})();

		return finalizePromise;
	}

	// 11. Lifecycle event bindings
	child.on('error', (err) => {
		const wrappedError = new AgentProcessError(
			spawnErrorCode(err),
			`Child process emitted error: ${err.message}`,
			{
				pid,
				launchSpecId: spec.runId,
				cause: err,
				stderrTail: stderrTailQueue.join('\n'),
			},
		);
		lastProcessError = wrappedError;
		dispatchError(wrappedError);
		if (child.pid === undefined) {
			exitReason = 'spawn-failed';
			void finalize();
		}
	});

	// Node does not guarantee stdio has been drained at 'exit'; finalizing there would
	// split the last output lines. 'exit' only arms a drain grace for the case where
	// 'close' never comes (a grandchild keeps the pipes open).
	child.on('exit', () => {
		if (isExited || finalizePromise !== null) return;
		if (exitDrainTimerId === undefined) {
			exitDrainTimerId = setTimeout(() => {
				void finalize();
			}, exitDrainGraceMs);
		}
	});

	// 'close' fires once every stdio stream has ended: the normal finalize path.
	child.on('close', () => {
		if (exitDrainTimerId !== undefined) {
			clearTimeout(exitDrainTimerId);
			exitDrainTimerId = undefined;
		}
		void finalize();
	});

	// Arm startup timer immediately upon spawn
	timers.armStartupTimer(() => void handleStartupTimeout());
	if (timers.hardWallClockMs > 0) {
		timers.armHardWallClockTimer(() => void handleHardWallClockTimeout());
	}
	if (timers.checkTimeoutMs > 0) {
		timers.armCheckTimer(() => void handleCheckTimeout());
	}

	let activeAppendQueue: AppendQueue | undefined = options.appendQueue;
	let detachQueue: (() => void) | undefined = undefined;

	function bindAppendQueue(queue: AppendQueue): () => void {
		if (child.stdout === null || typeof queue.attachStream !== 'function') return () => {};
		const unbind = queue.attachStream(child.stdout);
		return () => {
			unbind();
			if (activeAppendQueue === queue) {
				activeAppendQueue = undefined;
			}
		};
	}

	if (options.appendQueue !== undefined && child.stdout !== null) {
		detachQueue = bindAppendQueue(options.appendQueue);
	}

	const managed: ManagedProcess = {
		runId: spec.runId,
		pid,
		file: targetFile,
		args: targetArgs,
		cwd: spec.cwd,
		child,
		stdoutReader,
		stderrReader,
		timers,
		get appendQueue() {
			return activeAppendQueue;
		},
		get isExited() {
			return isExited;
		},
		get exitResult() {
			return exitResult;
		},
		get stderrTail() {
			return stderrTailQueue.join('\n');
		},
		get stderrTailLines() {
			return Object.freeze([...stderrTailQueue]);
		},
		attachAppendQueue(queue: AppendQueue): () => void {
			if (detachQueue !== undefined) {
				detachQueue();
			}
			activeAppendQueue = queue;
			detachQueue = bindAppendQueue(queue);
			return () => {
				if (detachQueue !== undefined) {
					detachQueue();
					detachQueue = undefined;
				}
			};
		},
		waitForStdinDrain(): Promise<void> {
			if (child.stdin === null || child.stdin.destroyed) {
				return Promise.resolve();
			}
			if (!child.stdin.writableNeedDrain) {
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				child.stdin?.once('drain', () => resolve());
			});
		},
		onStdinDrain(listener: () => void): () => void {
			if (child.stdin === null) return () => {};
			child.stdin.on('drain', listener);
			return () => {
				child.stdin?.off('drain', listener);
			};
		},
		writeStdin(data: string | Buffer): boolean {
			if (child.stdin === null || child.stdin.destroyed) {
				return false;
			}
			return child.stdin.write(data);
		},
		onLine(listener) {
			lineListeners.add(listener);
			return () => lineListeners.delete(listener);
		},
		onRaw(listener) {
			rawListeners.add(listener);
			return () => rawListeners.delete(listener);
		},
		onStderr(listener) {
			stderrListeners.add(listener);
			return () => stderrListeners.delete(listener);
		},
		onJson(listener) {
			jsonListeners.add(listener);
			return () => jsonListeners.delete(listener);
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onError(listener) {
			errorListeners.add(listener);
			return () => errorListeners.delete(listener);
		},
		kill,
		finalize,
	};

	if (options.registry !== undefined) {
		options.registry.register(managed);
	}

	return managed;
}

function spawnErrorCode(cause: unknown): ErrorCode {
	const code = (cause as NodeJS.ErrnoException).code;
	if (code === 'ENOENT') return 'E_AGENT_EXEC_NOT_FOUND';
	if (code === 'EACCES' || code === 'EPERM') return 'E_AGENT_EXEC_NOT_EXECUTABLE';
	return 'E_INTERNAL';
}

export function createDefaultProcessOps(platform: SupportedPlatform): KillTreeProcessOps {
	return {
		now: () => new Date().toISOString(),
		wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
		taskkill: async (args: readonly string[]) => {
			return new Promise((resolve) => {
				execFile('taskkill.exe', [...args], { windowsHide: true }, (err, _stdout, stderr) => {
					if (err === null) {
						resolve(args.includes('/F') ? 'terminated' : 'still-running');
					} else if (typeof err.code === 'number' && err.code === 128) {
						resolve(/not found/i.test(String(stderr)) ? 'terminated' : 'still-running');
					} else {
						resolve('still-running');
					}
				});
			});
		},
		signalGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
			try {
				process.kill(-pid, signal);
				return signal === 'SIGKILL' ? 'terminated' : 'still-running';
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === 'ESRCH') return 'terminated';
				if (code === 'EPERM') return 'not-process-owner';
				return 'still-running';
			}
		},
		probeTree: async (pid: number) => {
			if (platform === 'win32') {
				return new Promise((resolve) => {
					execFile(
						'tasklist.exe',
						['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
						{ windowsHide: true },
						(_err, stdout) => {
							const lines = String(stdout)
								.split(/\r?\n/)
								.filter((l) => l.trim().length > 0);
							const found = lines.some((l) => l.includes(`"${pid}"`));
							resolve(found ? 'still-running' : 'terminated');
						},
					);
				});
			}
			try {
				process.kill(pid, 0);
				return 'still-running';
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === 'ESRCH') return 'terminated';
				if (code === 'EPERM') return 'not-process-owner';
				return 'still-running';
			}
		},
		probeGroup: (pid: number) => {
			try {
				process.kill(-pid, 0);
				return 'still-running';
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				if (code === 'ESRCH') return 'terminated';
				if (code === 'EPERM') return 'not-process-owner';
				return 'still-running';
			}
		},
	};
}
