import { type EffortTier, isEffortTier, resolveEffortMapping } from '../../domain/effort-tier.ts';
import {
	type PermissionTier,
	isPermissionTier,
	resolvePermissionMapping,
} from '../../domain/permission-tier.ts';
import type { LaunchSpec } from '../../proc/spawn.ts';
import type { LaunchTimeouts } from '../../proc/timers.ts';

export interface BuildGrokLaunchSpecOptions {
	readonly runId: string;
	readonly cwd: string;
	readonly execPath?: string;
	readonly prompt?: string;
	readonly promptFile?: string;
	readonly model?: string | null;
	readonly sessionId?: string | null;
	readonly worktree?: string;
	readonly worktreeRef?: string;
	readonly permissionTier?: PermissionTier;
	readonly effortTier?: EffortTier;
	readonly timeouts?: LaunchTimeouts;
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly envDenylist?: readonly string[];
	readonly customArgs?: readonly string[];
	readonly argsTemplate?: readonly string[];
	readonly label?: string;
	readonly windowsComSpecPath?: string;
}

/**
 * Builds LaunchSpec for running the Grok agent CLI in headless ACP streaming mode.
 *
 * AC 1: Emits `--output-format streaming-json` for ACP native session update stream.
 * AC 3: Headless mode does NOT read piped stdin; prompt is passed strictly via `--prompt-file` or `-p` argument.
 * AC 4: Does not perform executable fingerprint checks (handled upstream by M4-T3).
 */
export function buildGrokLaunchSpec(options: BuildGrokLaunchSpecOptions): LaunchSpec {
	const file =
		options.execPath && options.execPath.trim().length > 0 ? options.execPath.trim() : 'grok';

	const args: string[] = [];

	// 1. Template arguments if provided
	if (options.argsTemplate && options.argsTemplate.length > 0) {
		for (let i = 0; i < options.argsTemplate.length; i++) {
			const arg = options.argsTemplate[i];
			if (arg === undefined) continue;

			if (arg === '{model}') {
				if (options.model) args.push(options.model.trim());
				continue;
			}
			if (arg === '{session_id}') {
				if (options.sessionId) args.push(options.sessionId.trim());
				continue;
			}
			if (arg === '{prompt}') {
				if (options.prompt) args.push(options.prompt.trim());
				continue;
			}
			if (arg === '{prompt_file}') {
				if (options.promptFile) args.push(options.promptFile.trim());
				continue;
			}
			if (arg === '{worktree}') {
				if (options.worktree) args.push(options.worktree);
				continue;
			}
			if (arg === '{worktree_ref}') {
				if (options.worktreeRef) args.push(options.worktreeRef);
				continue;
			}

			args.push(arg);
		}
	}

	// 2. Enforce `--output-format streaming-json` for ACP native output (AC 1)
	const outputFormatIdx = args.indexOf('--output-format');
	if (outputFormatIdx === -1) {
		args.push('--output-format', 'streaming-json');
	} else if (args[outputFormatIdx + 1] !== 'streaming-json') {
		args[outputFormatIdx + 1] = 'streaming-json';
	}

	// 3. Headless prompt handling: `--prompt-file` or `-p` (AC 3)
	// Headless grok does not read piped stdin; prompt must be provided via argument or file
	if (options.promptFile && options.promptFile.trim().length > 0) {
		if (!args.includes('--prompt-file')) {
			args.push('--prompt-file', options.promptFile.trim());
		}
	} else if (options.prompt && options.prompt.trim().length > 0) {
		if (!args.includes('-p') && !args.includes('--single')) {
			args.push('-p', options.prompt.trim());
		}
	}

	// 4. Model flag
	if (options.model && options.model.trim().length > 0) {
		if (!args.includes('--model') && !args.includes('-m')) {
			args.push('--model', options.model.trim());
		}
	}

	// 5. Session ID flag
	if (options.sessionId && options.sessionId.trim().length > 0) {
		if (!args.includes('--session-id') && !args.includes('-s')) {
			args.push('--session-id', options.sessionId.trim());
		}
	}

	// 6. Permission tier mapping
	if (
		options.permissionTier &&
		isPermissionTier(options.permissionTier) &&
		!args.includes('--permission-mode')
	) {
		const mapping = resolvePermissionMapping('grok', options.permissionTier);
		if (mapping.supported && mapping.transport.kind === 'argv') {
			args.push(...mapping.transport.args);
		}
	}

	// 7. Effort tier mapping
	if (
		options.effortTier &&
		isEffortTier(options.effortTier) &&
		!args.includes('--reasoning-effort') &&
		!args.includes('--effort')
	) {
		const effortMapping = resolveEffortMapping('grok', options.effortTier, {
			model: options.model,
		});
		if (effortMapping.supported && effortMapping.transport.kind === 'argv') {
			args.push(...effortMapping.transport.args);
		}
	}

	// 8. Worktree flags
	if (options.worktree && !args.includes('--worktree') && !args.includes('-w')) {
		args.push('--worktree', options.worktree);
	}
	if (options.worktreeRef && !args.includes('--worktree-ref') && !args.includes('--ref')) {
		args.push('--worktree-ref', options.worktreeRef);
	}

	// 9. Extra custom arguments
	if (options.customArgs && options.customArgs.length > 0) {
		for (const customArg of options.customArgs) {
			if (!args.includes(customArg)) {
				args.push(customArg);
			}
		}
	}

	return Object.freeze({
		runId: options.runId,
		file,
		args: Object.freeze(args),
		cwd: options.cwd,
		envOverrides: options.envOverrides ? Object.freeze({ ...options.envOverrides }) : undefined,
		envDenylist: options.envDenylist ? Object.freeze([...options.envDenylist]) : undefined,
		timeouts: options.timeouts,
		label: options.label ?? `grok-${options.runId}`,
		isAcp: true,
		windowsComSpecPath: options.windowsComSpecPath,
	});
}

export { buildGrokLaunchSpec as buildLaunchSpec };
