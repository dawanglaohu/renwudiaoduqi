import { type EffortTier, isEffortTier, resolveEffortMapping } from '../../domain/effort-tier.ts';
import { renderLaunchTemplate, validateLaunchTemplate } from '../../domain/launch-template.ts';
import { applyModelToArgsTemplate } from '../../domain/model-selection.ts';
import {
	type PermissionTier,
	isPermissionTier,
	resolvePermissionMapping,
} from '../../domain/permission-tier.ts';
import { AppError } from '../../errors/app-error.ts';
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
	readonly sessionDir?: string | null;
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
	if (!options.execPath || options.execPath.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'execPath is required to build grok launch spec');
	}
	const file = options.execPath.trim();

	let args: string[] = [];

	// 1. Template validation and rendering via domain/launch-template.ts (R1)
	if (options.argsTemplate && options.argsTemplate.length > 0) {
		const validation = validateLaunchTemplate(options.argsTemplate);
		if (!validation.ok) {
			throw new AppError('E_VALIDATION', validation.error.message, {
				details: { error: validation.error },
			});
		}

		// When model is omitted or null, remove '--model' / '-m' and placeholder to avoid dangling flag (E-35)
		const processedTemplate = applyModelToArgsTemplate(validation.template, options.model);

		const renderContext = {
			model: options.model?.trim() ?? null,
			promptFile: options.promptFile?.trim() ?? null,
			cwd: options.cwd,
			sessionDir: options.sessionDir ?? options.cwd,
		};

		const renderResult = renderLaunchTemplate(processedTemplate, renderContext);
		if (!renderResult.ok) {
			throw new AppError('E_VALIDATION', renderResult.error.message, {
				details: { error: renderResult.error },
			});
		}

		args = [...renderResult.args];
	}

	// 2. Enforce `--output-format streaming-json` for ACP native output (AC 1)
	const outputFormatIdx = args.indexOf('--output-format');
	if (outputFormatIdx === -1) {
		args.push('--output-format', 'streaming-json');
	} else if (args[outputFormatIdx + 1] !== 'streaming-json') {
		args[outputFormatIdx + 1] = 'streaming-json';
	}

	// 3. Headless prompt handling: `--prompt-file` or `-p` (AC 3, R1)
	// Headless grok does not read piped stdin. If template already contained `--single` or `-p`,
	// provide the prompt value without dropping it.
	const singleIdx = args.indexOf('--single');
	const pIdx = args.indexOf('-p');
	const promptFileIdx = args.indexOf('--prompt-file');

	const hasSingleValue =
		singleIdx !== -1 && args[singleIdx + 1] !== undefined && !args[singleIdx + 1]?.startsWith('-');

	const hasPValue = pIdx !== -1 && args[pIdx + 1] !== undefined && !args[pIdx + 1]?.startsWith('-');

	const hasPromptFileValue =
		promptFileIdx !== -1 &&
		args[promptFileIdx + 1] !== undefined &&
		!args[promptFileIdx + 1]?.startsWith('-');

	if (options.promptFile && options.promptFile.trim().length > 0) {
		const pfValue = options.promptFile.trim();
		// If template had --single or -p, remove them since we're using --prompt-file
		if (singleIdx !== -1) {
			args.splice(singleIdx, hasSingleValue ? 2 : 1);
		}
		const currentPIdx = args.indexOf('-p');
		if (currentPIdx !== -1) {
			const currentHasPValue =
				args[currentPIdx + 1] !== undefined && !args[currentPIdx + 1]?.startsWith('-');
			args.splice(currentPIdx, currentHasPValue ? 2 : 1);
		}

		const currentPfIdx = args.indexOf('--prompt-file');
		if (currentPfIdx === -1) {
			args.push('--prompt-file', pfValue);
		} else if (!hasPromptFileValue) {
			args[currentPfIdx + 1] = pfValue;
		}
	} else if (options.prompt && options.prompt.trim().length > 0) {
		const pValue = options.prompt.trim();
		if (singleIdx !== -1) {
			// Normalize --single to -p and ensure prompt value is attached
			args[singleIdx] = '-p';
			if (hasSingleValue) {
				args[singleIdx + 1] = pValue;
			} else {
				args.splice(singleIdx + 1, 0, pValue);
			}
		} else if (pIdx !== -1) {
			if (hasPValue) {
				args[pIdx + 1] = pValue;
			} else {
				args.splice(pIdx + 1, 0, pValue);
			}
		} else if (!hasPromptFileValue) {
			args.push('-p', pValue);
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
