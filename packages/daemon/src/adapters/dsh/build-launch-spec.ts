import type { AdapterKind } from '../../config/defaults.ts';
import {
	type PermissionTier,
	isPermissionTier,
	resolvePermissionMapping,
} from '../../domain/permission-tier.ts';
import type { LaunchSpec } from '../../proc/spawn.ts';

export const DEFAULT_DSH_BIN_PATH = 'resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js';

export interface BuildDshLaunchSpecOptions {
	readonly runId: string;
	readonly cwd: string;
	readonly execPath?: string;
	readonly model?: string | null;
	readonly prompt?: string;
	readonly permissionTier?: PermissionTier;
	readonly timeouts?: LaunchSpec['timeouts'];
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly envDenylist?: readonly string[];
	readonly customArgs?: readonly string[];
	readonly adapterKind?: AdapterKind;
	readonly label?: string;
	readonly windowsComSpecPath?: string;
}

/**
 * Builds the process launch specification for DeepSeek Harness (dsh).
 * Operates in headless profile mode: `dsh --profile headless "prompt"`.
 * If execPath points to an application-internal JavaScript file (bin.js), executes via node (E-193).
 */
export function buildDshLaunchSpec(options: BuildDshLaunchSpecOptions): LaunchSpec {
	const configuredPath =
		options.execPath && options.execPath.trim().length > 0
			? options.execPath.trim()
			: DEFAULT_DSH_BIN_PATH;

	let file: string;
	const args: string[] = [];

	if (configuredPath.endsWith('.js')) {
		file = process.execPath;
		args.push(configuredPath);
	} else {
		file = configuredPath;
	}

	args.push('--profile', 'headless');

	if (options.model && options.model.trim().length > 0) {
		args.push('--model', options.model.trim());
	}

	const envOverrides: Record<string, string | undefined> = {
		...(options.envOverrides ?? {}),
	};

	if (options.permissionTier && isPermissionTier(options.permissionTier)) {
		const permissionMapping = resolvePermissionMapping('dsh', options.permissionTier);
		if (permissionMapping.supported && permissionMapping.transport.kind === 'env') {
			for (const [key, value] of Object.entries(permissionMapping.transport.variables)) {
				envOverrides[key] = value;
			}
		}
	}

	if (options.customArgs && options.customArgs.length > 0) {
		for (const customArg of options.customArgs) {
			if (!args.includes(customArg)) {
				args.push(customArg);
			}
		}
	}

	if (options.prompt && options.prompt.trim().length > 0) {
		args.push(options.prompt.trim());
	}

	return Object.freeze({
		runId: options.runId,
		file,
		args: Object.freeze(args),
		cwd: options.cwd,
		envOverrides: Object.freeze(envOverrides),
		envDenylist: options.envDenylist,
		timeouts: options.timeouts,
		label: options.label ?? 'dsh-headless',
		windowsComSpecPath: options.windowsComSpecPath,
	});
}

export { buildDshLaunchSpec as buildLaunchSpec };
