import type { SupportedPlatform } from '../platform/contract.ts';

export const DEFAULT_ENV_DENYLIST = Object.freeze([
	'ANTHROPIC_MODEL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_SMALL_MODEL',
	'ANTHROPIC_MEDIUM_MODEL',
	'ANTHROPIC_LARGE_MODEL',
	'OPENAI_MODEL',
]);

const MODEL_OVERRIDE_PATTERN = /^ANTHROPIC_DEFAULT_.*_MODEL$/;

export interface ProcessEnvOptions {
	readonly platform: SupportedPlatform;
	readonly baseEnv?: Readonly<Record<string, string | undefined>>;
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly envDenylist?: readonly string[];
	readonly emptyGitConfigFile?: string;
}

export function createProcessEnv(options: ProcessEnvOptions): Readonly<Record<string, string>> {
	const platform = options.platform;

	const rawHostEnv: Record<string, string | undefined> =
		options.baseEnv ?? (process.env as Record<string, string | undefined>) ?? {};

	const denylist = new Set<string>(DEFAULT_ENV_DENYLIST);
	if (options.envDenylist !== undefined) {
		for (const key of options.envDenylist) {
			denylist.add(key);
		}
	}

	const result: Record<string, string> = {};

	// 1. Copy base environment filtering out undefined values, denylisted keys, and model override patterns (E-37).
	for (const [key, value] of Object.entries(rawHostEnv)) {
		if (value === undefined) continue;
		if (denylist.has(key)) continue;
		if (MODEL_OVERRIDE_PATTERN.test(key)) continue;
		result[key] = value;
	}

	// 2. Apply custom overrides (excluding any attempting to inject denylisted variables).
	if (options.envOverrides !== undefined) {
		for (const [key, value] of Object.entries(options.envOverrides)) {
			if (value === undefined) {
				delete result[key];
				continue;
			}
			if (denylist.has(key)) continue;
			if (MODEL_OVERRIDE_PATTERN.test(key)) continue;
			result[key] = value;
		}
	}

	// 3. Enforce mandatory UTF-8 and color disabling (E-131).
	result.LANG = 'en_US.UTF-8';
	result.LC_ALL = 'en_US.UTF-8';
	result.NO_COLOR = '1';
	result.FORCE_COLOR = '0';

	// 4. Enforce git credentials disabling (E-138).
	// Five mandatory settings: GIT_TERMINAL_PROMPT=0, GIT_ASKPASS='', GCM_INTERACTIVE=never,
	// GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=<empty file / null device>.
	result.GIT_TERMINAL_PROMPT = '0';
	result.GIT_ASKPASS = '';
	result.GCM_INTERACTIVE = 'never';
	result.GIT_CONFIG_NOSYSTEM = '1';
	result.GIT_CONFIG_GLOBAL =
		options.emptyGitConfigFile ?? (platform === 'win32' ? 'NUL' : '/dev/null');

	return Object.freeze(result);
}
