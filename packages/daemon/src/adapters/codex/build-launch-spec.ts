import type { AdapterKind } from '../../config/defaults.ts';
import { type EffortTier, isEffortTier, resolveEffortMapping } from '../../domain/effort-tier.ts';
import {
	type PermissionTier,
	isPermissionTier,
	resolvePermissionMapping,
} from '../../domain/permission-tier.ts';
import type { LaunchSpec } from '../../proc/spawn.ts';

export type CodexLaunchMode = 'app-server' | 'exec';

export interface BuildCodexLaunchSpecOptions {
	readonly runId: string;
	readonly cwd: string;
	readonly execPath?: string;
	readonly mode?: CodexLaunchMode;
	readonly model?: string | null;
	readonly prompt?: string;
	readonly promptFile?: string;
	readonly permissionTier?: PermissionTier;
	readonly effortTier?: EffortTier;
	readonly timeouts?: LaunchSpec['timeouts'];
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly envDenylist?: readonly string[];
	readonly customArgs?: readonly string[];
	readonly adapterKind?: AdapterKind;
	readonly label?: string;
	readonly windowsComSpecPath?: string;
}

/**
 * Builds the process launch specification for Codex.
 * Primary mode: `app-server` (stdio JSON-RPC protocol).
 * Fallback mode: `exec` (`codex exec --json` CLI fallback for robustness).
 */
export function buildCodexLaunchSpec(options: BuildCodexLaunchSpecOptions): LaunchSpec {
	const file = options.execPath && options.execPath.trim().length > 0 ? options.execPath : 'codex';

	// Determine whether to use app-server (primary) or exec (fallback/退路)
	let mode: CodexLaunchMode = options.mode ?? 'app-server';
	if (options.customArgs && options.customArgs.length > 0) {
		if (options.customArgs.includes('exec')) {
			mode = 'exec';
		} else if (options.customArgs.includes('app-server')) {
			mode = 'app-server';
		}
	}

	const args: string[] = [];

	if (mode === 'app-server') {
		// Primary mode: codex app-server --listen stdio://
		args.push('app-server', '--listen', 'stdio://');

		if (options.model && options.model.trim().length > 0) {
			args.push('-c', `model="${options.model.trim()}"`);
		}

		if (options.effortTier && isEffortTier(options.effortTier)) {
			const effortMapping = resolveEffortMapping('codex', options.effortTier);
			if (effortMapping.supported && effortMapping.transport.kind === 'argv') {
				args.push(...effortMapping.transport.args);
			}
		}

		if (options.permissionTier && isPermissionTier(options.permissionTier)) {
			const permissionMapping = resolvePermissionMapping('codex', options.permissionTier);
			if (permissionMapping.supported && permissionMapping.transport.kind === 'argv') {
				const flagValue = permissionMapping.transport.value;
				args.push('-c', `sandbox="${flagValue}"`);
			}
		}
	} else {
		// Fallback mode: codex exec --json
		args.push('exec', '--json');

		if (options.model && options.model.trim().length > 0) {
			args.push('--model', options.model.trim());
		}

		if (options.effortTier && isEffortTier(options.effortTier)) {
			const effortMapping = resolveEffortMapping('codex', options.effortTier);
			if (effortMapping.supported && effortMapping.transport.kind === 'argv') {
				args.push(...effortMapping.transport.args);
			}
		}

		if (options.permissionTier && isPermissionTier(options.permissionTier)) {
			const permissionMapping = resolvePermissionMapping('codex', options.permissionTier);
			if (permissionMapping.supported && permissionMapping.transport.kind === 'argv') {
				args.push(...permissionMapping.transport.args);
			}
		}

		if (options.promptFile && options.promptFile.trim().length > 0) {
			args.push('--output-schema', options.promptFile.trim());
		}

		if (options.prompt && options.prompt.trim().length > 0) {
			args.push(options.prompt.trim());
		}
	}

	if (options.customArgs && options.customArgs.length > 0) {
		for (const customArg of options.customArgs) {
			if (!args.includes(customArg)) {
				args.push(customArg);
			}
		}
	}

	const isAcp = options.adapterKind === 'generic-acp';

	return Object.freeze({
		runId: options.runId,
		file,
		args: Object.freeze(args),
		cwd: options.cwd,
		envOverrides: options.envOverrides,
		envDenylist: options.envDenylist,
		timeouts: options.timeouts,
		label: options.label ?? `codex-${mode}`,
		isAcp: isAcp || undefined,
		windowsComSpecPath: options.windowsComSpecPath,
	});
}

export { buildCodexLaunchSpec as buildLaunchSpec };
