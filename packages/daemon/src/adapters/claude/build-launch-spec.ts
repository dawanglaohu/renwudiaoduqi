import { type EffortTier, resolveEffortMapping } from '../../domain/effort-tier.ts';
import { type PermissionTier, resolvePermissionMapping } from '../../domain/permission-tier.ts';
import { AppError } from '../../errors/app-error.ts';
import type { LaunchSpec } from '../../proc/spawn.ts';
import type { LaunchTimeouts } from '../../proc/timers.ts';

export const CLAUDE_ENV_DENYLIST = Object.freeze([
	'ANTHROPIC_MODEL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_SMALL_MODEL',
	'ANTHROPIC_MEDIUM_MODEL',
	'ANTHROPIC_LARGE_MODEL',
	'OPENAI_MODEL',
]);

const MODEL_OVERRIDE_PATTERN = /^ANTHROPIC_DEFAULT_.*_MODEL$/i;

/**
 * Pure function that cleans Anthropic model override environment variables from the given environment (E-37).
 */
export function cleanClaudeEnv(
	rawEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	const denylist = new Set<string>(CLAUDE_ENV_DENYLIST);
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(rawEnv)) {
		if (value === undefined) continue;
		if (denylist.has(key)) continue;
		if (MODEL_OVERRIDE_PATTERN.test(key)) continue;
		result[key] = value;
	}

	return Object.freeze(result);
}

export interface BuildClaudeLaunchSpecOptions {
	readonly runId: string;
	readonly execPath?: string;
	readonly cwd: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly permissionTier?: PermissionTier;
	readonly effortTier?: EffortTier;
	readonly isBackground?: boolean;
	readonly sessionId?: string;
	readonly extraArgs?: readonly string[];
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly timeouts?: LaunchTimeouts;
	readonly label?: string;
	readonly argsTemplate?: readonly string[];
}

export type ClaudeAgentState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

export interface ClaudeAgentSessionInfo {
	readonly id: string;
	readonly state: ClaudeAgentState;
	readonly waitingFor: string | null;
	readonly sessionId: string;
	readonly pid?: number;
	readonly cwd?: string;
	readonly kind?: string;
	readonly startedAt?: string;
	readonly status?: string;
	readonly name?: string;
	readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * Builds LaunchSpec for running the Claude CLI agent.
 * Enforces AC 1: --bg and -p/--print are mutually exclusive and NEVER used together.
 * Enforces AC 2 & E-37: Cleans ANTHROPIC_MODEL and ANTHROPIC_DEFAULT_*_MODEL from child process env.
 */
export function buildClaudeLaunchSpec(options: BuildClaudeLaunchSpecOptions): LaunchSpec {
	const isBackground = options.isBackground ?? false;
	const file = options.execPath ?? 'claude';
	const args: string[] = [];

	// 1. Initial arguments from argsTemplate or defaults
	const baseArgs = options.argsTemplate ? [...options.argsTemplate] : [];

	if (isBackground) {
		// In background mode (--bg), ensure -p / --print is removed (AC 1)
		for (const arg of baseArgs) {
			if (arg === '-p' || arg === '--print') continue;
			// Replace template variable if present
			if (arg === '{model}') {
				if (options.model) args.push(options.model);
			} else {
				args.push(arg);
			}
		}

		if (!args.includes('--bg') && !args.includes('--background')) {
			args.unshift('--bg');
		}
	} else {
		// In foreground streaming mode, ensure --bg is removed and -p is present (AC 1)
		for (const arg of baseArgs) {
			if (arg === '--bg' || arg === '--background') continue;
			if (arg === '{model}') {
				if (options.model) args.push(options.model);
			} else {
				args.push(arg);
			}
		}

		if (!args.includes('-p') && !args.includes('--print')) {
			args.unshift('--print');
		}
		if (!args.includes('--output-format')) {
			args.push('--output-format', 'stream-json');
		}
		if (!args.includes('--input-format')) {
			args.push('--input-format', 'stream-json');
		}
	}

	// 2. Model flag
	if (options.model && !args.includes('--model') && !args.includes('-m')) {
		args.push('--model', options.model);
	}

	// 3. Permission mode mapping
	if (options.permissionTier && !args.includes('--permission-mode')) {
		const mapping = resolvePermissionMapping('claude', options.permissionTier);
		if (mapping.supported && mapping.transport.kind === 'argv') {
			args.push(...mapping.transport.args);
		}
	}

	// 4. Reasoning effort mapping
	if (options.effortTier) {
		const effortMapping = resolveEffortMapping('claude', options.effortTier, {
			model: options.model,
		});
		if (effortMapping.supported && effortMapping.transport.kind === 'argv') {
			args.push(...effortMapping.transport.args);
		}
	}

	// 5. Session ID
	if (options.sessionId && !args.includes('--session-id')) {
		args.push('--session-id', options.sessionId);
	}

	// 6. Extra arguments
	if (options.extraArgs && options.extraArgs.length > 0) {
		args.push(...options.extraArgs);
	}

	// 7. Prompt (if provided)
	if (options.prompt?.trim()) {
		args.push(options.prompt.trim());
	}

	// 8. Strict mutually-exclusive validation (AC 1)
	const hasBg = args.includes('--bg') || args.includes('--background');
	const hasPrint = args.includes('-p') || args.includes('--print');

	if (hasBg && hasPrint) {
		throw new AppError(
			'E_VALIDATION',
			'Claude CLI arguments conflict: --bg and -p/--print cannot be used simultaneously.',
			{
				details: {
					runId: options.runId,
					isBackground,
					args,
				},
			},
		);
	}

	// 9. Environment overrides sanitized (AC 2 & E-37)
	const cleanOverrides: Record<string, string> = {};
	if (options.envOverrides) {
		const cleaned = cleanClaudeEnv(options.envOverrides);
		Object.assign(cleanOverrides, cleaned);
	}

	return Object.freeze({
		runId: options.runId,
		file,
		args: Object.freeze(args),
		cwd: options.cwd,
		envOverrides: Object.freeze(cleanOverrides),
		envDenylist: CLAUDE_ENV_DENYLIST,
		timeouts: options.timeouts,
		label: options.label ?? `claude-${options.runId}`,
		isAcp: false,
	});
}

export interface BuildClaudeAgentsQuerySpecOptions {
	readonly execPath?: string;
	readonly cwd?: string;
	readonly all?: boolean;
	readonly runId?: string;
}

/**
 * Builds LaunchSpec for querying running background sessions via `claude agents --json` (AC 1).
 */
export function buildClaudeAgentsQuerySpec(
	options: BuildClaudeAgentsQuerySpecOptions = {},
): LaunchSpec {
	const file = options.execPath ?? 'claude';
	const args: string[] = ['agents', '--json'];

	if (options.all) {
		args.push('--all');
	}
	if (options.cwd) {
		args.push('--cwd', options.cwd);
	}

	return Object.freeze({
		runId: options.runId ?? 'claude-agents-query',
		file,
		args: Object.freeze(args),
		cwd: options.cwd ?? process.cwd(),
		envDenylist: CLAUDE_ENV_DENYLIST,
		label: 'claude-agents-query',
		isAcp: false,
	});
}

const VALID_CLAUDE_STATES: ReadonlySet<string> = new Set([
	'working',
	'blocked',
	'done',
	'failed',
	'stopped',
]);

/**
 * Parses the JSON array output from `claude agents --json` (AC 1).
 * Extracts `state`, `waitingFor`, `sessionId`, `pid`, etc.
 */
export function parseClaudeAgentsJson(jsonOutput: string): readonly ClaudeAgentSessionInfo[] {
	const trimmed = jsonOutput.trim();
	if (!trimmed) {
		return Object.freeze([]);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		throw new AppError(
			'E_VALIDATION',
			'Failed to parse claude agents --json output: Invalid JSON.',
			{
				cause: err,
				details: { rawSnippet: trimmed.slice(0, 200) },
			},
		);
	}

	if (!Array.isArray(parsed)) {
		throw new AppError(
			'E_VALIDATION',
			'Failed to parse claude agents --json output: Expected a JSON array.',
			{
				details: { observedType: typeof parsed },
			},
		);
	}

	const results: ClaudeAgentSessionInfo[] = [];

	for (const item of parsed) {
		if (!item || typeof item !== 'object') continue;
		const obj = item as Record<string, unknown>;

		const rawState = typeof obj.state === 'string' ? obj.state.trim().toLowerCase() : '';
		const state: ClaudeAgentState = VALID_CLAUDE_STATES.has(rawState)
			? (rawState as ClaudeAgentState)
			: 'working';

		const waitingFor =
			typeof obj.waitingFor === 'string'
				? obj.waitingFor.trim()
				: typeof obj.waiting_for === 'string'
					? obj.waiting_for.trim()
					: null;

		const sessionId =
			typeof obj.sessionId === 'string'
				? obj.sessionId.trim()
				: typeof obj.session_id === 'string'
					? obj.session_id.trim()
					: '';

		const id =
			typeof obj.id === 'string'
				? obj.id.trim()
				: sessionId || (typeof obj.pid === 'number' ? String(obj.pid) : '');

		const pid = typeof obj.pid === 'number' ? obj.pid : undefined;
		const cwd = typeof obj.cwd === 'string' ? obj.cwd : undefined;
		const kind = typeof obj.kind === 'string' ? obj.kind : undefined;
		const startedAt = typeof obj.startedAt === 'string' ? obj.startedAt : undefined;
		const status = typeof obj.status === 'string' ? obj.status : undefined;
		const name = typeof obj.name === 'string' ? obj.name : undefined;

		results.push(
			Object.freeze({
				id,
				state,
				waitingFor,
				sessionId,
				pid,
				cwd,
				kind,
				startedAt,
				status,
				name,
				raw: Object.freeze({ ...obj }),
			}),
		);
	}

	return Object.freeze(results);
}

/**
 * Helper to find a specific Claude agent session from parsed sessions.
 */
export function findClaudeAgentSession(
	sessions: readonly ClaudeAgentSessionInfo[],
	predicate: { readonly sessionId?: string; readonly id?: string; readonly pid?: number },
): ClaudeAgentSessionInfo | undefined {
	return sessions.find((s) => {
		if (predicate.sessionId && s.sessionId === predicate.sessionId) return true;
		if (predicate.id && s.id === predicate.id) return true;
		if (predicate.pid !== undefined && s.pid === predicate.pid) return true;
		return false;
	});
}

export { buildClaudeLaunchSpec as buildLaunchSpec };
