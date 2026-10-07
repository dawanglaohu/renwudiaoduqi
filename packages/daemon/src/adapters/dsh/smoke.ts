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
	readonly model?: string | null;
	readonly runner: (params: DshSmokeRunnerParams) => Promise<DshSmokeRunnerResult>;
}

/**
 * Runs the dsh smoke test contract verification (AC 3, E-191, E-28).
 * Contract: `dsh --profile headless --json "任务"`
 * Checks:
 *  1. Process can be spawned.
 *  2. Exit code is 0 (turn/end completed).
 *  3. stderr is empty; JSON mode suppresses native reasoning progress.
 *  4. stdout is NDJSON ending in a nonempty final assistant text record.
 * Any mismatch fails the test and prevents enabling or dispatch.
 */
export async function runDshSmokeTest(options: DshSmokeTestOptions): Promise<DshSmokeTestResult> {
	const prompt = options.smokePrompt ?? 'Reply exactly OK. Do not use tools or change any files.';
	const cwd = options.cwd ?? process.cwd();
	let launchSpec: ReturnType<typeof buildDshLaunchSpec>;
	try {
		launchSpec = buildDshLaunchSpec({
			runId: 'dsh-smoke',
			cwd,
			execPath: options.execPath,
			prompt,
			model: options.model,
			customArgs: ['--json'],
		});
	} catch (error) {
		return Object.freeze({
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		});
	}

	let runnerResult: DshSmokeRunnerResult;
	try {
		runnerResult = await options.runner({
			file: launchSpec.file,
			args: launchSpec.args,
			cwd: launchSpec.cwd,
			timeoutMs: options.timeoutMs ?? 60_000,
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

	const trimmedStderr = runnerResult.stderr.trim();
	if (runnerResult.stderr.length > 0) {
		return Object.freeze({
			ok: false,
			reason: `dsh contract violation: unexpected stderr on success: ${trimmedStderr}`,
			stdout: runnerResult.stdout,
			stderr: runnerResult.stderr,
			exitCode: runnerResult.exitCode,
		});
	}

	const trimmedStdout = runnerResult.stdout.trim();
	let terminalText = '';
	try {
		const records: unknown[] = trimmedStdout.split(/\r?\n/).map((line) => JSON.parse(line));
		if (
			records.every(
				(record) =>
					typeof record === 'object' &&
					record !== null &&
					'type' in record &&
					typeof record.type === 'string',
			) &&
			records.filter((record) => (record as { type: string }).type === 'final').length === 1
		) {
			const final = records.at(-1) as { type: string; text?: unknown };
			if (final.type === 'final' && typeof final.text === 'string')
				terminalText = final.text.trim();
		}
	} catch {
		// Invalid JSON or missing final output fails the smoke contract.
	}
	if (terminalText.length === 0) {
		return Object.freeze({
			ok: false,
			reason:
				'dsh contract violation: expected terminal assistant text on stdout in a final JSON record',
			stdout: runnerResult.stdout,
			stderr: runnerResult.stderr,
			exitCode: runnerResult.exitCode,
		});
	}

	return Object.freeze({
		ok: true,
		stdout: terminalText,
		stderr: runnerResult.stderr,
		exitCode: 0,
	});
}
