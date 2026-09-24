import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';

export interface SpawnOptionsInjection {
	readonly spawn?: (
		file: string,
		args: readonly string[],
		options: {
			cwd: string;
			shell: boolean;
			windowsHide?: boolean;
			detached?: boolean;
			stdio?: 'ignore' | 'pipe' | 'inherit';
			env?: Readonly<Record<string, string>>;
		},
	) => ChildProcess;
	/**
	 * Environment handed to the daemon. The frozen spec fixes `file/args/cwd`; the product's
	 * own `AGSCHED_*` variables are how a smoke check keeps the daemon away from the
	 * machine's real port and data directory. Production call sites leave it undefined and
	 * inherit the shell's environment.
	 */
	readonly env?: Readonly<Record<string, string>>;
	/** Streams the daemon's own output into this process; `'ignore'` by default. */
	readonly stdio?: 'ignore' | 'pipe' | 'inherit';
}

export interface LaunchDaemonResult {
	readonly success: boolean;
	readonly pid?: number;
	readonly error?: string;
}

/**
 * Launches the daemon process directly from the frozen DaemonLaunchSpec.
 *
 * Requirements (AC 2, E-146, E-209):
 * - Direct execution without shell (shell: false).
 * - No scheduling or retry policies embedded in the shell container.
 * - Non-fatal: returns structured launch status.
 */
export function launchDaemon(
	spec: DaemonLaunchSpec,
	injection?: SpawnOptionsInjection,
): LaunchDaemonResult {
	try {
		const spawnFunction = injection?.spawn ?? nodeSpawn;
		const child = spawnFunction(spec.file, spec.args, {
			cwd: spec.cwd,
			shell: false,
			windowsHide: true,
			detached: true,
			stdio: injection?.stdio ?? 'ignore',
			...(injection?.env ? { env: injection.env } : {}),
		});

		if (child.unref) {
			child.unref();
		}

		return Object.freeze({
			success: true,
			pid: child.pid,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown execution failure';
		return Object.freeze({
			success: false,
			error: errorMessage,
		});
	}
}
