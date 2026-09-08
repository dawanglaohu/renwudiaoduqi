/**
 * Whitelist of allowed launch template variables.
 */
export const ALLOWED_TEMPLATE_VARIABLES = ['model', 'prompt_file', 'cwd', 'session_dir'] as const;

export type AllowedTemplateVariable = (typeof ALLOWED_TEMPLATE_VARIABLES)[number];

export function isAllowedTemplateVariable(name: string): name is AllowedTemplateVariable {
	return (ALLOWED_TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

export type LaunchTemplateSyntaxErrorKind =
	| 'unknown-variable'
	| 'unclosed-brace'
	| 'unexpected-closing-brace'
	| 'empty-variable'
	| 'nested-brace';

export interface LaunchTemplateErrorLocation {
	readonly argumentIndex: number;
	readonly rawArgument: string;
	readonly startIndex: number;
	readonly endIndex: number;
	readonly reason: LaunchTemplateSyntaxErrorKind;
	readonly variableName?: string;
	readonly highlight: string;
	readonly message: string;
}

/**
 * Creates visual caret highlight pointing to the error position in the raw argument.
 */
export function formatTemplateErrorHighlight(
	rawArgument: string,
	startIndex: number,
	endIndex: number,
): string {
	const clampedStart = Math.max(0, Math.min(startIndex, rawArgument.length));
	const clampedEnd = Math.max(clampedStart + 1, Math.min(endIndex, rawArgument.length));
	const width = Math.max(1, clampedEnd - clampedStart);
	const caretLine = ' '.repeat(clampedStart) + '^'.repeat(width);
	return `${rawArgument}\n${caretLine}`;
}

export type TemplateToken =
	| { readonly type: 'literal'; readonly text: string }
	| { readonly type: 'variable'; readonly variableName: AllowedTemplateVariable };

/**
 * Validates a single launch template argument string.
 * Returns null if valid, or a structured LaunchTemplateErrorLocation with highlight if invalid.
 */
export function validateTemplateArgument(
	rawArgument: string,
	argumentIndex = 0,
): LaunchTemplateErrorLocation | null {
	let inBrace = false;
	let braceStartIndex = -1;

	for (let index = 0; index < rawArgument.length; index++) {
		const char = rawArgument[index];
		if (char === '{') {
			if (inBrace) {
				const highlight = formatTemplateErrorHighlight(rawArgument, index, index + 1);
				return Object.freeze({
					argumentIndex,
					rawArgument,
					startIndex: index,
					endIndex: index + 1,
					reason: 'nested-brace',
					highlight,
					message: `Unexpected nested opening brace '{' at index ${index} in argument ${argumentIndex}:\n${highlight}`,
				});
			}
			inBrace = true;
			braceStartIndex = index;
		} else if (char === '}') {
			if (!inBrace) {
				const highlight = formatTemplateErrorHighlight(rawArgument, index, index + 1);
				return Object.freeze({
					argumentIndex,
					rawArgument,
					startIndex: index,
					endIndex: index + 1,
					reason: 'unexpected-closing-brace',
					highlight,
					message: `Unexpected closing brace '}' without opening brace at index ${index} in argument ${argumentIndex}:\n${highlight}`,
				});
			}
			const variableName = rawArgument.slice(braceStartIndex + 1, index);
			if (variableName.length === 0) {
				const highlight = formatTemplateErrorHighlight(rawArgument, braceStartIndex, index + 1);
				return Object.freeze({
					argumentIndex,
					rawArgument,
					startIndex: braceStartIndex,
					endIndex: index + 1,
					reason: 'empty-variable',
					highlight,
					message: `Empty template variable '{}' at index ${braceStartIndex} in argument ${argumentIndex}:\n${highlight}`,
				});
			}
			if (!isAllowedTemplateVariable(variableName)) {
				const highlight = formatTemplateErrorHighlight(rawArgument, braceStartIndex, index + 1);
				return Object.freeze({
					argumentIndex,
					rawArgument,
					startIndex: braceStartIndex,
					endIndex: index + 1,
					reason: 'unknown-variable',
					variableName,
					highlight,
					message: `Unknown template variable "{${variableName}}" at index ${braceStartIndex} in argument ${argumentIndex}; allowed variables are {model}, {prompt_file}, {cwd}, {session_dir}:\n${highlight}`,
				});
			}
			inBrace = false;
			braceStartIndex = -1;
		}
	}

	if (inBrace) {
		const highlight = formatTemplateErrorHighlight(
			rawArgument,
			braceStartIndex,
			rawArgument.length,
		);
		return Object.freeze({
			argumentIndex,
			rawArgument,
			startIndex: braceStartIndex,
			endIndex: rawArgument.length,
			reason: 'unclosed-brace',
			highlight,
			message: `Unclosed brace '{' starting at index ${braceStartIndex} in argument ${argumentIndex}:\n${highlight}`,
		});
	}

	return null;
}

/**
 * Parses a validated template argument string into literal and variable tokens.
 */
export function parseTemplateArgumentTokens(
	rawArgument: string,
	argumentIndex = 0,
): readonly TemplateToken[] {
	const error = validateTemplateArgument(rawArgument, argumentIndex);
	if (error !== null) {
		throw new Error(error.message);
	}

	const tokens: TemplateToken[] = [];
	let cursor = 0;

	while (cursor < rawArgument.length) {
		const openIndex = rawArgument.indexOf('{', cursor);
		if (openIndex === -1) {
			tokens.push({ type: 'literal', text: rawArgument.slice(cursor) });
			break;
		}
		if (openIndex > cursor) {
			tokens.push({ type: 'literal', text: rawArgument.slice(cursor, openIndex) });
		}
		const closeIndex = rawArgument.indexOf('}', openIndex);
		const varName = rawArgument.slice(openIndex + 1, closeIndex) as AllowedTemplateVariable;
		tokens.push({ type: 'variable', variableName: varName });
		cursor = closeIndex + 1;
	}

	return Object.freeze(tokens);
}

declare const ValidatedLaunchTemplateBrand: unique symbol;

export type ValidatedLaunchTemplate = readonly string[] & {
	readonly [ValidatedLaunchTemplateBrand]: true;
};

export type LaunchTemplateValidationResult =
	| { readonly ok: true; readonly template: ValidatedLaunchTemplate }
	| { readonly ok: false; readonly error: LaunchTemplateErrorLocation };

/**
 * Validates an entire argsTemplate array.
 * Rejects any unknown template variable or unclosed brace.
 */
export function validateLaunchTemplate(
	argsTemplate: readonly string[],
): LaunchTemplateValidationResult {
	for (let index = 0; index < argsTemplate.length; index++) {
		const arg = argsTemplate[index];
		if (arg === undefined) continue;
		const error = validateTemplateArgument(arg, index);
		if (error !== null) {
			return { ok: false, error };
		}
	}
	return {
		ok: true,
		template: Object.freeze([...argsTemplate]) as ValidatedLaunchTemplate,
	};
}

export interface LaunchTemplateContext {
	readonly model?: string | null;
	readonly promptFile?: string | null;
	readonly cwd?: string | null;
	readonly sessionDir?: string | null;
}

/**
 * Pure template substitution for launch arguments.
 * Replaces {model}, {prompt_file}, {cwd}, {session_dir} with values from context.
 * Throws an Error if the template contains invalid syntax or if a variable has no value.
 */
export function renderLaunchTemplate(
	template: ValidatedLaunchTemplate | readonly string[],
	context: LaunchTemplateContext,
): readonly string[] {
	const validation = validateLaunchTemplate(template);
	if (!validation.ok) {
		throw new Error(`Invalid launch template: ${validation.error.message}`);
	}

	const renderedArgs: string[] = [];
	for (let index = 0; index < validation.template.length; index++) {
		const arg = validation.template[index];
		if (arg === undefined) continue;

		const tokens = parseTemplateArgumentTokens(arg, index);
		let renderedArg = '';
		for (const token of tokens) {
			if (token.type === 'literal') {
				renderedArg += token.text;
			} else {
				renderedArg += resolveContextVariableValue(token.variableName, context, index, arg);
			}
		}
		renderedArgs.push(renderedArg);
	}

	return Object.freeze(renderedArgs);
}

function resolveContextVariableValue(
	variableName: AllowedTemplateVariable,
	context: LaunchTemplateContext,
	argumentIndex: number,
	rawArgument: string,
): string {
	let value: string | null | undefined;
	switch (variableName) {
		case 'model':
			value = context.model;
			break;
		case 'prompt_file':
			value = context.promptFile;
			break;
		case 'cwd':
			value = context.cwd;
			break;
		case 'session_dir':
			value = context.sessionDir;
			break;
	}

	if (value === null || value === undefined) {
		throw new Error(
			`Missing template variable {${variableName}} for argument ${argumentIndex} ("${rawArgument}")`,
		);
	}
	return value;
}

export const SESSION_DIR_OVERWRITE_WARNING_MESSAGE =
	'Session records may overwrite each other' as const;

export interface SessionDirOverlapWarning {
	readonly kind: 'agent.availability_changed';
	readonly severity: 'warning';
	readonly reason: 'session-dir-overlap';
	readonly message: typeof SESSION_DIR_OVERWRITE_WARNING_MESSAGE;
	readonly agentId: string;
	readonly peerAgentId: string;
	readonly execPath: string;
	readonly sessionDir: string;
	readonly detail: string;
}

export type PlatformTarget = 'win32' | 'posix';

export interface PathIdentityOptions {
	readonly platform?: PlatformTarget;
}

/**
 * Normalizes an executable path or session directory path for identity comparison.
 * When platform is 'win32', paths are case-insensitive and both slash types are normalized.
 * When platform is 'posix', case is preserved and backslashes are NOT converted.
 */
export function normalizePathIdentity(
	pathValue: string,
	platform: PlatformTarget = 'posix',
): string {
	const trimmed = pathValue.trim();
	if (platform === 'win32') {
		const forwardSlashes = trimmed.replaceAll('\\', '/');
		const noTrailing = forwardSlashes.replace(/\/+$/, '');
		return noTrailing.toLowerCase();
	}
	return trimmed.replace(/\/+$/, '');
}

export function isSamePathIdentity(
	pathA: string,
	pathB: string,
	platform: PlatformTarget = 'posix',
): boolean {
	return normalizePathIdentity(pathA, platform) === normalizePathIdentity(pathB, platform);
}

/**
 * Extracts session directory from an argsTemplate array if present.
 */
export function extractSessionDirFromArgsTemplate(
	argsTemplate?: readonly string[],
): string | undefined {
	if (!argsTemplate || argsTemplate.length === 0) return undefined;

	for (let index = 0; index < argsTemplate.length; index++) {
		const arg = argsTemplate[index];
		if (arg === undefined) continue;
		if (arg === '--session-dir' || arg === '--session_dir') {
			if (index + 1 < argsTemplate.length) {
				return argsTemplate[index + 1];
			}
		}
		if (arg.startsWith('--session-dir=') || arg.startsWith('--session_dir=')) {
			return arg.slice(arg.indexOf('=') + 1);
		}
	}
	return undefined;
}

/**
 * Resolves the effective session identity for an agent.
 */
export function resolveAgentSessionIdentity(
	agent: {
		readonly execPath?: string;
		readonly argsTemplate?: readonly string[];
	},
	platform: PlatformTarget = 'posix',
): string {
	const fromArgs = extractSessionDirFromArgsTemplate(agent.argsTemplate);
	if (fromArgs !== undefined) {
		return `dir:${normalizePathIdentity(fromArgs, platform)}`;
	}
	const execIdentity = normalizePathIdentity(agent.execPath ?? '', platform);
	return `default:${execIdentity}`;
}

export function isSameSessionIdentity(
	agentA: { readonly execPath?: string; readonly argsTemplate?: readonly string[] },
	agentB: { readonly execPath?: string; readonly argsTemplate?: readonly string[] },
	platform: PlatformTarget = 'posix',
): boolean {
	return (
		resolveAgentSessionIdentity(agentA, platform) === resolveAgentSessionIdentity(agentB, platform)
	);
}

/**
 * Checks if two agents share the same executable path and same session directory.
 */
export function checkSessionDirOverlap(
	agentA: { readonly execPath: string; readonly argsTemplate?: readonly string[] },
	agentB: { readonly execPath: string; readonly argsTemplate?: readonly string[] },
	agentIdA = 'agentA',
	agentIdB = 'agentB',
	options: PathIdentityOptions = {},
): SessionDirOverlapWarning | null {
	const platform = options.platform ?? 'posix';
	if (!isSamePathIdentity(agentA.execPath, agentB.execPath, platform)) {
		return null;
	}

	const sessionA = resolveAgentSessionIdentity(agentA, platform);
	const sessionB = resolveAgentSessionIdentity(agentB, platform);

	if (sessionA !== sessionB) {
		return null;
	}

	const rawSessionDir =
		extractSessionDirFromArgsTemplate(agentA.argsTemplate) ??
		extractSessionDirFromArgsTemplate(agentB.argsTemplate) ??
		`default:${normalizePathIdentity(agentA.execPath, platform)}`;

	return Object.freeze({
		kind: 'agent.availability_changed',
		severity: 'warning',
		reason: 'session-dir-overlap',
		message: SESSION_DIR_OVERWRITE_WARNING_MESSAGE,
		agentId: agentIdA,
		peerAgentId: agentIdB,
		execPath: agentA.execPath,
		sessionDir: rawSessionDir,
		detail: `Agents '${agentIdA}' and '${agentIdB}' share executable '${agentA.execPath}' and session directory '${rawSessionDir}'. Session records may overwrite each other.`,
	});
}

/**
 * Detects session directory overlaps across all configured agents.
 */
export function detectSessionDirOverlaps(
	agents: Readonly<
		Record<string, { readonly execPath?: string; readonly argsTemplate?: readonly string[] }>
	>,
	options: PathIdentityOptions = {},
): readonly SessionDirOverlapWarning[] {
	const entries = Object.entries(agents).filter(
		([_, config]) => typeof config.execPath === 'string' && config.execPath.trim().length > 0,
	);
	const warnings: SessionDirOverlapWarning[] = [];

	for (let i = 0; i < entries.length; i++) {
		const entryA = entries[i];
		if (entryA === undefined) continue;
		const [idA, configA] = entryA;

		for (let j = i + 1; j < entries.length; j++) {
			const entryB = entries[j];
			if (entryB === undefined) continue;
			const [idB, configB] = entryB;
			const warning = checkSessionDirOverlap(
				configA as { readonly execPath: string; readonly argsTemplate?: readonly string[] },
				configB as { readonly execPath: string; readonly argsTemplate?: readonly string[] },
				idA,
				idB,
				options,
			);
			if (warning !== null) {
				warnings.push(warning);
			}
		}
	}

	return Object.freeze(warnings);
}
