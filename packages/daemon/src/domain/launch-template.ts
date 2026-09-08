import { AppError } from '../errors/app-error.ts';

/**
 * Whitelist of allowed launch template variables.
 * Criterion 1: Only {model}, {prompt_file}, {cwd}, {session_dir} are allowed.
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
 * E-89: Highlights error location clearly for developer diagnostics.
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
		throw new AppError('E_VALIDATION', error.message, { details: { ...error } });
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
 * Rejects any unknown template variable or unclosed brace (E-89).
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

/**
 * Asserts that an argsTemplate array is valid, throwing an AppError with code E_VALIDATION
 * and the visual highlight in message & details if invalid.
 */
export function assertValidLaunchTemplate(
	argsTemplate: readonly string[],
	agentId?: string,
): ValidatedLaunchTemplate {
	const result = validateLaunchTemplate(argsTemplate);
	if (!result.ok) {
		const prefix = agentId !== undefined ? `Agent '${agentId}' argsTemplate` : 'ArgsTemplate';
		throw new AppError(
			'E_VALIDATION',
			`${prefix} contains invalid template syntax: ${result.error.message}`,
			{
				details: {
					agentId,
					argumentIndex: result.error.argumentIndex,
					rawArgument: result.error.rawArgument,
					startIndex: result.error.startIndex,
					endIndex: result.error.endIndex,
					reason: result.error.reason,
					variableName: result.error.variableName,
					highlight: result.error.highlight,
				},
			},
		);
	}
	return result.template;
}

export interface LaunchTemplateContext {
	readonly model?: string | null;
	readonly promptFile?: string | null;
	readonly cwd?: string | null;
	readonly sessionDir?: string | null;
}

export interface RenderLaunchTemplateOptions {
	/**
	 * When model is null or undefined, omit `--model <model>`, `--model=<model>`, or `{model}` from launch arguments.
	 * Default: true (conforms to M4-T6 / E-35 requirement: missing model does not pass `--model`).
	 */
	readonly omitUnspecifiedModel?: boolean;
}

/**
 * Renders launch arguments from a template.
 * Criterion 2: Runtime NEVER uses an unvalidated template — validation runs first.
 */
export function renderLaunchTemplate(
	template: ValidatedLaunchTemplate | readonly string[],
	context: LaunchTemplateContext,
	options: RenderLaunchTemplateOptions = {},
): readonly string[] {
	const validated = assertValidLaunchTemplate(template);
	const omitModel = options.omitUnspecifiedModel ?? true;
	const renderedArgs: string[] = [];

	for (let index = 0; index < validated.length; index++) {
		const arg = validated[index];
		if (arg === undefined) continue;

		// Case 1: `--model` followed by `{model}` when model is unspecified
		const nextArg = index + 1 < validated.length ? validated[index + 1] : undefined;
		if (
			omitModel &&
			(context.model === null || context.model === undefined) &&
			arg === '--model' &&
			nextArg === '{model}'
		) {
			index++;
			continue;
		}

		// Case 2: `--model={model}` when model is unspecified
		if (
			omitModel &&
			(context.model === null || context.model === undefined) &&
			arg === '--model={model}'
		) {
			continue;
		}

		// Case 3: standalone `{model}` when model is unspecified
		if (omitModel && (context.model === null || context.model === undefined) && arg === '{model}') {
			continue;
		}

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
	switch (variableName) {
		case 'model':
			if (context.model === null || context.model === undefined) {
				throw new AppError(
					'E_VALIDATION',
					`Launch template variable {model} in argument ${argumentIndex} ("${rawArgument}") has no model provided in context`,
					{ details: { variable: 'model', argumentIndex, rawArgument } },
				);
			}
			return context.model;
		case 'prompt_file':
			if (context.promptFile === null || context.promptFile === undefined) {
				throw new AppError(
					'E_VALIDATION',
					`Launch template variable {prompt_file} in argument ${argumentIndex} ("${rawArgument}") has no promptFile provided in context`,
					{ details: { variable: 'prompt_file', argumentIndex, rawArgument } },
				);
			}
			return context.promptFile;
		case 'cwd':
			if (context.cwd === null || context.cwd === undefined) {
				throw new AppError(
					'E_VALIDATION',
					`Launch template variable {cwd} in argument ${argumentIndex} ("${rawArgument}") has no cwd provided in context`,
					{ details: { variable: 'cwd', argumentIndex, rawArgument } },
				);
			}
			return context.cwd;
		case 'session_dir':
			if (context.sessionDir === null || context.sessionDir === undefined) {
				throw new AppError(
					'E_VALIDATION',
					`Launch template variable {session_dir} in argument ${argumentIndex} ("${rawArgument}") has no sessionDir provided in context`,
					{ details: { variable: 'session_dir', argumentIndex, rawArgument } },
				);
			}
			return context.sessionDir;
	}
}

/**
 * Exact warning text required by E-95 and Criterion 3.
 */
export const SESSION_DIR_OVERWRITE_WARNING_MESSAGE = '会话记录可能互相覆盖' as const;

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

export function normalizeExecPath(execPath: string): string {
	const trimmed = execPath.trim();
	const normalizedSlashes = trimmed.replaceAll('\\', '/');
	const noTrailing = normalizedSlashes.replace(/\/+$/, '');
	// Windows absolute paths (drive letter) or .exe binaries are case-insensitive
	const isWindowsLike = /^[a-zA-Z]:/.test(noTrailing) || /\.exe$/i.test(noTrailing);
	return isWindowsLike ? noTrailing.toLowerCase() : noTrailing;
}

export function isSameExecPath(execPathA: string, execPathB: string): boolean {
	return normalizeExecPath(execPathA) === normalizeExecPath(execPathB);
}

/**
 * Extracts session directory from an argsTemplate array if present (e.g. `--session-dir <dir>` or `--session-dir=<dir>`).
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
 * Resolves the effective session directory for an agent.
 * If argsTemplate specifies --session-dir, that is used; otherwise defaults to the canonical executable.
 */
export function resolveAgentSessionDir(agent: {
	readonly execPath?: string;
	readonly argsTemplate?: readonly string[];
}): string {
	const fromArgs = extractSessionDirFromArgsTemplate(agent.argsTemplate);
	if (fromArgs !== undefined) {
		return fromArgs;
	}
	const exec = normalizeExecPath(agent.execPath ?? 'default');
	return `default:${exec}`;
}

export function isSameSessionDir(dirA: string, dirB: string): boolean {
	return normalizeExecPath(dirA) === normalizeExecPath(dirB);
}

/**
 * Checks if two agents share the same executable path and same session directory.
 * Criterion 3 & E-95: Allowed, but warns "会话记录可能互相覆盖".
 */
export function checkSessionDirOverlap(
	agentA: { readonly execPath: string; readonly argsTemplate?: readonly string[] },
	agentB: { readonly execPath: string; readonly argsTemplate?: readonly string[] },
	agentIdA = 'agentA',
	agentIdB = 'agentB',
): SessionDirOverlapWarning | null {
	if (!isSameExecPath(agentA.execPath, agentB.execPath)) {
		return null;
	}

	const dirA = resolveAgentSessionDir(agentA);
	const dirB = resolveAgentSessionDir(agentB);

	if (!isSameSessionDir(dirA, dirB)) {
		return null;
	}

	return Object.freeze({
		kind: 'agent.availability_changed',
		severity: 'warning',
		reason: 'session-dir-overlap',
		message: SESSION_DIR_OVERWRITE_WARNING_MESSAGE,
		agentId: agentIdA,
		peerAgentId: agentIdB,
		execPath: agentA.execPath,
		sessionDir: dirA,
		detail: `Agents '${agentIdA}' and '${agentIdB}' share executable '${agentA.execPath}' and session directory '${dirA}'. Session records may overwrite each other (会话记录可能互相覆盖).`,
	});
}

/**
 * Detects session directory overlaps across all configured agents.
 * E-95: User copied agent configuration without changing path/session directory.
 */
export function detectSessionDirOverlaps(
	agents: Readonly<
		Record<string, { readonly execPath?: string; readonly argsTemplate?: readonly string[] }>
	>,
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
			);
			if (warning !== null) {
				warnings.push(warning);
			}
		}
	}

	return Object.freeze(warnings);
}

export interface AgentSaveConfigInput {
	readonly execPath?: string;
	readonly argsTemplate?: readonly string[];
	readonly defaultModel?: string | null;
	readonly [key: string]: unknown;
}

export type SaveValidationResult =
	| {
			readonly ok: true;
			readonly validatedTemplates: Readonly<Record<string, ValidatedLaunchTemplate>>;
			readonly warnings: readonly SessionDirOverlapWarning[];
	  }
	| {
			readonly ok: false;
			readonly agentId: string;
			readonly error: LaunchTemplateErrorLocation;
			readonly appError: AppError;
	  };

/**
 * Validates agent configurations at save-time.
 * Criterion 1 & E-89: Rejects immediately on unknown template variables or unclosed braces.
 * Criterion 3 & E-95: Emits warnings if two agents share the same execPath and sessionDir.
 */
export function validateAgentsForSave(
	agents: Readonly<Record<string, AgentSaveConfigInput>>,
): SaveValidationResult {
	const validatedTemplates: Record<string, ValidatedLaunchTemplate> = {};

	for (const [agentId, config] of Object.entries(agents)) {
		if (config.argsTemplate !== undefined) {
			const result = validateLaunchTemplate(config.argsTemplate);
			if (!result.ok) {
				const appError = new AppError(
					'E_VALIDATION',
					`Agent '${agentId}' has invalid launch template argument at index ${result.error.argumentIndex}: ${result.error.reason}\n${result.error.highlight}`,
					{
						details: {
							agentId,
							argumentIndex: result.error.argumentIndex,
							rawArgument: result.error.rawArgument,
							startIndex: result.error.startIndex,
							endIndex: result.error.endIndex,
							reason: result.error.reason,
							variableName: result.error.variableName,
							highlight: result.error.highlight,
						},
					},
				);
				return {
					ok: false,
					agentId,
					error: result.error,
					appError,
				};
			}
			validatedTemplates[agentId] = result.template;
		}
	}

	const warnings = detectSessionDirOverlaps(agents);
	return {
		ok: true,
		validatedTemplates: Object.freeze(validatedTemplates),
		warnings,
	};
}

/**
 * Asserts all agent configurations are valid for saving.
 * Throws AppError('E_VALIDATION') if any template is invalid.
 * Returns warnings (e.g. E-95) if all are valid.
 */
export function assertAgentsForSave(
	agents: Readonly<Record<string, AgentSaveConfigInput>>,
): readonly SessionDirOverlapWarning[] {
	const result = validateAgentsForSave(agents);
	if (!result.ok) {
		throw result.appError;
	}
	return result.warnings;
}
