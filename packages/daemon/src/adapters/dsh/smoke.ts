import { buildDshLaunchSpec } from './build-launch-spec.ts';

export interface DshSmokeTestResult {
	readonly ok: boolean;
	readonly reason?: string;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number | null;
	readonly timedOut?: boolean;
}

export interface DshSmokeRunnerParams {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly timeoutMs?: number;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface DshSmokeRunnerResult {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut?: boolean;
}

export interface DshSmokeTestOptions {
	readonly execPath?: string;
	readonly cwd?: string;
	readonly smokePrompt?: string;
	readonly timeoutMs?: number;
	readonly runner: (params: DshSmokeRunnerParams) => Promise<DshSmokeRunnerResult>;
}

/**
 * Runs the dsh smoke test contract verification (AC 3, E-191, E-28).
 * Contract: `dsh --profile headless "任务"`
 * Checks:
 *  1. Process can be spawned.
 *  2. Exit code is 0 (turn/end completed).
 *  3. stderr is empty (no runtime errors).
 *  4. stdout contains terminal assistant text.
 * Any mismatch fails the test and prevents enabling or dispatch.
 */
export async function runDshSmokeTest(options: DshSmokeTestOptions): Promise<DshSmokeTestResult> {
	const prompt = options.smokePrompt ?? 'smoke-test';
	const cwd = options.cwd ?? process.cwd();
	const launchSpec = buildDshLaunchSpec({
		runId: 'dsh-smoke',
		cwd,
		execPath: options.execPath,
		prompt,
	});

	let runnerResult: DshSmokeRunnerResult;
	try {
		runnerResult = await options.runner({
			file: launchSpec.file,
			args: launchSpec.args,
			cwd: launchSpec.cwd,
			timeoutMs: options.timeoutMs ?? 10_000,
			env: launchSpec.envOverrides,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Object.freeze({
			ok: false,
			reason: `dsh process failed to start: ${message}`,
			exitCode: null,
		});
	}

	if (runnerResult.timedOut) {
		return Object.freeze({
			ok: false,
			reason: 'dsh smoke test timed out',
			stdout: runnerResult.stdout,
			stderr: runnerResult.stderr,
			exitCode: runnerResult.exitCode,
			timedOut: true,
		});
	}

	// 1. Exit code must be 0
	if (runnerResult.exitCode !== 0) {
		return Object.freeze({
			ok: false,
			reason: `dsh exited with non-zero exit code: ${runnerResult.exitCode}`,
			stdout: runnerResult.stdout,
			stderr: runnerResult.stderr,
			exitCode: runnerResult.exitCode,
		});
	}

	// 2. Successful contract requires stderr to be empty (E-191)
	const trimmedStderr = runnerResult.stderr.trim();
	if (trimmedStderr.length > 0) {
		return Object.freeze({
			ok: false,
			reason: `dsh contract violation: expected empty stderr on success, observed: ${trimmedStderr}`,
			stdout: runnerResult.stdout,
			stderr: runnerResult.stderr,
			exitCode: runnerResult.exitCode,
		});
	}

	// 3. Successful contract requires stdout to contain terminal assistant text
	const trimmedStdout = runnerResult.stdout.trim();
	if (trimmedStdout.length === 0) {
		return Object.freeze({
			ok: false,
			reason:
				'dsh contract violation: expected terminal assistant text on stdout, observed empty stdout',
			stdout: runnerResult.stdout,
			stderr: runnerResult.stderr,
			exitCode: runnerResult.exitCode,
		});
	}

	return Object.freeze({
		ok: true,
		stdout: trimmedStdout,
		stderr: '',
		exitCode: 0,
	});
}
