import { type EffortTier, resolveEffortMapping } from '../../domain/effort-tier.ts';
import { type PermissionTier, resolvePermissionMapping } from '../../domain/permission-tier.ts';
import type { LaunchSpec } from '../../proc/spawn.ts';
import type { LaunchTimeouts } from '../../proc/timers.ts';

export interface BuildPiLaunchSpecOptions {
	readonly runId: string;
	readonly execPath?: string;
	readonly cwd: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly sessionDir?: string;
	readonly noSession?: boolean;
	readonly permissionTier?: PermissionTier;
	readonly effortTier?: EffortTier;
	readonly extraArgs?: readonly string[];
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly timeouts?: LaunchTimeouts;
	readonly label?: string;
	readonly argsTemplate?: readonly string[];
}

/**
 * Builds LaunchSpec for running the Pi agent CLI.
 * Enforces AC 1: Runs in RPC mode with `--mode rpc`.
 */
export function buildPiLaunchSpec(options: BuildPiLaunchSpecOptions): LaunchSpec {
	const file = options.execPath ?? 'pi';
	const args: string[] = [];

	// 1. Initial arguments from argsTemplate or defaults
	const baseArgs = options.argsTemplate ? [...options.argsTemplate] : [];

	for (let i = 0; i < baseArgs.length; i++) {
		const arg = baseArgs[i];
		if (arg === undefined) continue;

		if (arg === '{model}') {
			if (options.model) args.push(options.model);
			continue;
		}
		if (arg === '{session_dir}') {
			if (options.sessionDir) args.push(options.sessionDir);
			continue;
		}

		if (arg === '--mode') {
			args.push('--mode', 'rpc');
			// Skip the template value for mode if present
			const next = baseArgs[i + 1];
			if (next !== undefined && !next.startsWith('-')) {
				i++;
			}
			continue;
		}

		args.push(arg);
	}

	// 2. Enforce `--mode rpc` (AC 1)
	const modeIndex = args.indexOf('--mode');
	if (modeIndex === -1) {
		args.push('--mode', 'rpc');
	} else if (args[modeIndex + 1] !== 'rpc') {
		args[modeIndex + 1] = 'rpc';
	}

	// 3. Model flag
	if (options.model && !args.includes('--model') && !args.includes('-m')) {
		args.push('--model', options.model);
	}

	// 4. Session directory
	if (options.sessionDir && !args.includes('--session-dir')) {
		args.push('--session-dir', options.sessionDir);
	}

	// 5. No session flag
	if (options.noSession && !args.includes('--no-session')) {
		args.push('--no-session');
	}

	// 6. Permission tier mapping
	if (options.permissionTier && !args.includes('--tools')) {
		const mapping = resolvePermissionMapping('pi', options.permissionTier);
		if (mapping.supported && mapping.transport.kind === 'argv') {
			args.push(...mapping.transport.args);
		}
	}

	// 7. Reasoning effort mapping
	if (options.effortTier && !args.includes('--thinking')) {
		const effortMapping = resolveEffortMapping('pi', options.effortTier, { model: options.model });
		if (effortMapping.supported && effortMapping.transport.kind === 'argv') {
			args.push(...effortMapping.transport.args);
		}
	}

	// 8. Extra arguments
	if (options.extraArgs && options.extraArgs.length > 0) {
		args.push(...options.extraArgs);
	}

	// 9. Optional prompt
	if (options.prompt?.trim()) {
		args.push(options.prompt.trim());
	}

	return Object.freeze({
		runId: options.runId,
		file,
		args: Object.freeze(args),
		cwd: options.cwd,
		envOverrides: options.envOverrides ? Object.freeze({ ...options.envOverrides }) : undefined,
		timeouts: options.timeouts,
		label: options.label ?? `pi-${options.runId}`,
		isAcp: false,
	});
}

export { buildPiLaunchSpec as buildLaunchSpec };
