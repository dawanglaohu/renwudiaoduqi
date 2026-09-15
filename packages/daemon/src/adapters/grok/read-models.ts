import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EffortValue } from '@agent-scheduler/shared/api/agents';
import type {
	PlatformHostInputs,
	ResolveExecutableInput,
	ResolveExecutableResult,
	ResolvedExecutable,
} from '../../platform/contract.ts';
import { resolveExecutable as resolvePlatformExecutable } from '../../platform/resolve-executable.ts';
import { wrapForComSpec } from '../../platform/windows.ts';

export interface ModelOption {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly isDefault?: boolean;
}

export interface ConfigErrorInfo {
	readonly path: string;
	readonly error: string;
}

export interface ReadModelsResult {
	readonly models: readonly ModelOption[];
	readonly currentConfigModel: string | null;
	readonly currentConfigEffort?: EffortValue;
	readonly isPartial: boolean;
	readonly warnings: readonly string[];
	readonly rawStdout?: string;
	readonly configError?: ConfigErrorInfo;
	readonly configErrors?: readonly ConfigErrorInfo[];
	readonly mtimeMs?: number | null;
}

export function normalizeHistoryModelName(name: string): string {
	return name;
}

export interface ModelReaderFileStat {
	readonly mtimeMs: number;
}

export interface ModelReaderFileSystem {
	readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
	readonly stat: (path: string) => Promise<ModelReaderFileStat>;
}

export const DEFAULT_MODEL_FILE_SYSTEM: ModelReaderFileSystem = Object.freeze({
	readFile: (path: string, encoding: 'utf8') => nodeReadFile(path, encoding),
	stat: async (path: string) => {
		const s = await nodeStat(path);
		return { mtimeMs: s.mtimeMs };
	},
});

export const MAX_COMMAND_TIMEOUT_MS = 5000;

export interface AbsoluteCommandLaunchSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	readonly windowsVerbatimArguments?: true;
}

export interface CommandExecutionResult {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/**
 * Starts the supplied absolute launch with `shell: false`, honors `signal`, and resolves only
 * after the child process has terminated and its output streams have settled.
 */
export type CommandRunner = (spec: AbsoluteCommandLaunchSpec) => Promise<CommandExecutionResult>;

export type ExecutableResolver = (
	input: ResolveExecutableInput,
) => Promise<ResolveExecutableResult>;

export interface ReadGrokModelsOptions {
	readonly hostInputs?:
		| PlatformHostInputs
		| { readonly homedir: string; readonly platform?: string };
	readonly homedir?: string;
	readonly configPath?: string;
	readonly executablePath?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
	readonly commandRunner?: CommandRunner;
	readonly timeoutMs?: number;
	readonly allowCommand?: boolean;
	readonly fs?: ModelReaderFileSystem;
	readonly resolveExecutable?: ExecutableResolver;
}

/**
 * Parses a subset of TOML used by Grok configuration files.
 * Supports key-value pairs, string escaping, basic tables, dotted keys, and arrays.
 * Throws SyntaxError on malformed syntax or unquoted bare values.
 */
export function parseToml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentTable: Record<string, unknown> = result;
	const lines = text.split(/\r?\n/);

	let i = 0;
	while (i < lines.length) {
		const rawLine = lines[i];
		i++;
		if (rawLine === undefined) continue;
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		if (line.startsWith('[')) {
			if (!line.endsWith(']')) {
				throw new SyntaxError(`Malformed TOML table header: ${line}`);
			}
			const isArray = line.startsWith('[[') && line.endsWith(']]');
			const header = isArray ? line.slice(2, -2).trim() : line.slice(1, -1).trim();
			if (!header) {
				throw new SyntaxError(`Empty TOML table header: ${line}`);
			}
			const keys = splitTomlKey(header);
			if (keys.length === 0) {
				throw new SyntaxError(`Invalid TOML table header: ${line}`);
			}
			const lastKey = keys[keys.length - 1];
			if (lastKey === undefined) {
				throw new SyntaxError(`Invalid TOML table header: ${line}`);
			}

			let target = result;
			for (const key of keys.slice(0, -1)) {
				if (target[key] === undefined || typeof target[key] !== 'object' || target[key] === null) {
					target[key] = {};
				}
				target = target[key] as Record<string, unknown>;
			}
			if (isArray) {
				if (!Array.isArray(target[lastKey])) {
					target[lastKey] = [];
				}
				const newTable: Record<string, unknown> = {};
				(target[lastKey] as unknown[]).push(newTable);
				currentTable = newTable;
			} else {
				if (
					target[lastKey] === undefined ||
					typeof target[lastKey] !== 'object' ||
					target[lastKey] === null
				) {
					target[lastKey] = {};
				}
				currentTable = target[lastKey] as Record<string, unknown>;
			}
			continue;
		}

		const eqIdx = findEqualsIndex(line);
		if (eqIdx === -1) {
			throw new SyntaxError(`Expected '=' in TOML key-value pair: ${line}`);
		}

		const rawKey = line.slice(0, eqIdx).trim();
		let rawVal = line.slice(eqIdx + 1).trim();
		if (!rawKey) {
			throw new SyntaxError(`Missing key in TOML line: ${line}`);
		}

		if (rawVal.startsWith('[') && !isBracketBalanced(rawVal)) {
			while (i < lines.length && !isBracketBalanced(rawVal)) {
				const nextLine = lines[i];
				if (nextLine !== undefined) {
					rawVal += ` ${nextLine.trim()}`;
				}
				i++;
			}
			if (!isBracketBalanced(rawVal)) {
				throw new SyntaxError(`Unclosed array in TOML: ${rawVal}`);
			}
		}

		const val = parseTomlValue(rawVal);
		const keys = splitTomlKey(rawKey);
		if (keys.length === 0) {
			throw new SyntaxError(`Missing key in TOML line: ${line}`);
		}
		const lastKey = keys[keys.length - 1];
		if (lastKey === undefined) {
			throw new SyntaxError(`Missing key in TOML line: ${line}`);
		}

		let target = currentTable;
		for (const key of keys.slice(0, -1)) {
			if (target[key] === undefined || typeof target[key] !== 'object' || target[key] === null) {
				target[key] = {};
			}
			target = target[key] as Record<string, unknown>;
		}
		target[lastKey] = val;
	}

	return result;
}

function findEqualsIndex(line: string): number {
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"' && !inSingle && (i === 0 || line[i - 1] !== '\\')) {
			inDouble = !inDouble;
		} else if (c === "'" && !inDouble) {
			inSingle = !inSingle;
		} else if (c === '=' && !inDouble && !inSingle) {
			return i;
		} else if (c === '#' && !inDouble && !inSingle) {
			return -1;
		}
	}
	return -1;
}

function isBracketBalanced(str: string): number | boolean {
	let bracket = 0;
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (c === '"' && !inSingle && (i === 0 || str[i - 1] !== '\\')) {
			inDouble = !inDouble;
		} else if (c === "'" && !inDouble) {
			inSingle = !inSingle;
		} else if (!inDouble && !inSingle) {
			if (c === '[') bracket++;
			else if (c === ']') bracket--;
		}
	}
	return bracket <= 0;
}

function splitTomlKey(keyStr: string): string[] {
	const keys: string[] = [];
	let current = '';
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < keyStr.length; i++) {
		const c = keyStr[i];
		if (c === '"' && !inSingle && (i === 0 || keyStr[i - 1] !== '\\')) {
			inDouble = !inDouble;
			current += c;
		} else if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			current += c;
		} else if (c === '.' && !inDouble && !inSingle) {
			const cleaned = cleanKey(current.trim());
			if (cleaned) keys.push(cleaned);
			current = '';
		} else {
			current += c;
		}
	}
	const cleaned = cleanKey(current.trim());
	if (cleaned) keys.push(cleaned);
	return keys;
}

function cleanKey(k: string): string {
	if (k.startsWith('"') && k.endsWith('"')) {
		try {
			return JSON.parse(k) as string;
		} catch {
			return k.slice(1, -1);
		}
	}
	if (k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1);
	return k;
}

function parseTomlValue(valStr: string): unknown {
	const trimmed = stripTrailingComment(valStr).trim();
	if (trimmed === '') {
		throw new SyntaxError('Empty value in TOML key-value pair');
	}
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (trimmed.startsWith('"')) {
		if (!trimmed.endsWith('"') || trimmed.length < 2) {
			throw new SyntaxError(`Unterminated string in TOML: ${trimmed}`);
		}
		try {
			return JSON.parse(trimmed);
		} catch (err) {
			throw new SyntaxError(
				`Invalid string escape in TOML: ${trimmed} (${(err as Error).message})`,
			);
		}
	}
	if (trimmed.startsWith("'")) {
		if (!trimmed.endsWith("'") || trimmed.length < 2) {
			throw new SyntaxError(`Unterminated single-quoted string in TOML: ${trimmed}`);
		}
		return trimmed.slice(1, -1);
	}
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return Number(trimmed);
	}
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return splitArrayItems(inner).map((item) => parseTomlValue(item));
	}
	// TOML strings must be quoted; accepting arbitrary bare tokens would turn damaged config into model IDs.
	throw new SyntaxError(`Invalid TOML value (unquoted string or invalid token): ${trimmed}`);
}

function stripTrailingComment(str: string): string {
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (c === '"' && !inSingle && (i === 0 || str[i - 1] !== '\\')) inDouble = !inDouble;
		else if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (c === '#' && !inDouble && !inSingle) return str.slice(0, i);
	}
	return str;
}

function splitArrayItems(str: string): string[] {
	const items: string[] = [];
	let current = '';
	let inDouble = false;
	let inSingle = false;
	let depth = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (c === '"' && !inSingle && (i === 0 || str[i - 1] !== '\\')) inDouble = !inDouble;
		else if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (!inDouble && !inSingle) {
			if (c === '[') depth++;
			else if (c === ']') depth--;
			else if (c === ',' && depth === 0) {
				if (current.trim()) items.push(current.trim());
				current = '';
				continue;
			}
		}
		current += c;
	}
	if (current.trim()) items.push(current.trim());
	return items;
}

/**
 * Extracts models from `grok models` CLI command output.
 * Matches lines like:
 *   * grok-4.6 (default)
 *   * grok-4.5
 *   - grok-beta
 */
export function parseGrokModelsOutput(stdout: string): ModelOption[] {
	const models: ModelOption[] = [];
	const lines = stdout.split(/\r?\n/);
	const bulletRegex = /^\s*[*•-]\s*([a-zA-Z0-9_.:-]+)(?:\s*\(([^)]+)\))?/;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		const match = line.match(bulletRegex);
		if (match && match[1] !== undefined) {
			const id = match[1].trim();
			const tag = match[2]?.trim().toLowerCase();
			const isDefault = tag?.includes('default') ?? false;
			models.push({ id, isDefault });
		}
	}

	return models;
}

export const parseGrokModelsCommandOutput = parseGrokModelsOutput;

/**
 * Reads model catalog for Grok agent from ~/.grok/config.toml and `grok models`.
 * If `grok models` reaches its 5000ms hard ceiling or fails with a non-zero exit code:
 *   downgrades to config current + historical + manual and marks isPartial (E-38).
 * If output format changes and cannot be parsed:
 *   downgrades and retains raw stdout (E-39).
 * If config is missing or damaged:
 *   returns no config value without crashing (E-43).
 * Reads mtime on every call (E-44).
 */
export async function readGrokModels(
	options: ReadGrokModelsOptions = {},
): Promise<ReadModelsResult> {
	const fs = options.fs ?? DEFAULT_MODEL_FILE_SYSTEM;
	const homedirPath = options.hostInputs?.homedir ?? options.homedir;

	if (!options.configPath && !homedirPath) {
		return Object.freeze({
			models: Object.freeze([]),
			currentConfigModel: null,
			isPartial: false,
			warnings: Object.freeze(['Neither configPath nor hostInputs.homedir was provided.']),
			configError: Object.freeze({
				path: '',
				error: 'Host snapshot with homedir or configPath is required',
			}),
			mtimeMs: null,
		});
	}

	const configPath = resolve(
		options.configPath ?? join(homedirPath as string, '.grok', 'config.toml'),
	);
	// Callers may lower the timeout for tests or policy, but cannot enlarge the production ceiling.
	const timeoutMs = Math.max(
		1,
		Math.min(options.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS),
	);

	const warnings: string[] = [];
	let currentConfigModel: string | null = null;
	let configError: ConfigErrorInfo | undefined;
	let mtimeMs: number | null = null;
	let isPartial = false;
	let rawStdout: string | undefined;
	const modelMap = new Map<string, ModelOption>();

	// 1. Read config.toml asynchronously
	try {
		const stat = await fs.stat(configPath);
		mtimeMs = stat.mtimeMs;
		const content = await fs.readFile(configPath, 'utf8');
		const parsed = parseToml(content);

		// Extract default model
		if (parsed.models && typeof parsed.models === 'object') {
			const modelsSection = parsed.models as Record<string, unknown>;
			if (typeof modelsSection.default === 'string' && modelsSection.default.trim()) {
				currentConfigModel = modelsSection.default.trim();
			}
		}
		if (!currentConfigModel && typeof parsed.model === 'string' && parsed.model.trim()) {
			currentConfigModel = parsed.model.trim();
		}

		if (currentConfigModel) {
			modelMap.set(currentConfigModel, { id: currentConfigModel, isDefault: true });
		}

		// Extract models from [model.*]
		if (parsed.model && typeof parsed.model === 'object') {
			const modelSection = parsed.model as Record<string, unknown>;
			for (const [modelKey, modelVal] of Object.entries(modelSection)) {
				if (modelVal && typeof modelVal === 'object') {
					const mObj = modelVal as Record<string, unknown>;
					const id = typeof mObj.model === 'string' ? mObj.model.trim() : modelKey.trim();
					const name = typeof mObj.name === 'string' ? mObj.name.trim() : undefined;
					if (id) {
						const existing = modelMap.get(id);
						modelMap.set(id, { ...existing, id, name: existing?.name ?? name });
					}
				}
			}
		}

		// Extract models from [ui]
		if (parsed.ui && typeof parsed.ui === 'object') {
			const ui = parsed.ui as Record<string, unknown>;
			if (typeof ui.fork_secondary_model === 'string' && ui.fork_secondary_model.trim()) {
				const id = ui.fork_secondary_model.trim();
				if (!modelMap.has(id)) {
					modelMap.set(id, { id });
				}
			}
		}
	} catch (err) {
		const errorObj = err as { code?: string; message?: string };
		const isNotFound = errorObj.code === 'ENOENT';
		const errorMsg = isNotFound
			? 'Config file does not exist'
			: (errorObj.message ?? 'Unknown read error');
		configError = Object.freeze({
			path: configPath,
			error: errorMsg,
		});
		warnings.push(`Failed to read Grok config at ${configPath}: ${errorMsg}`);
		currentConfigModel = null;
	}

	// 2. Run `grok models` through a fully resolved absolute launch object.
	if (options.commandRunner && options.allowCommand !== false) {
		const hostInputs = platformHostInputs(options.hostInputs);
		const resolved = hostInputs
			? await (options.resolveExecutable ?? resolvePlatformExecutable)({
					hostInputs,
					executableName: 'grok',
					configuredPath: options.executablePath,
				})
			: null;
		const launch = resolved?.ok
			? buildCommandLaunch(resolved.executable, Object.freeze(['models']))
			: null;

		if (!launch) {
			// If not resolvable to absolute path, flag partial and skip unverified execution
			isPartial = true;
			warnings.push(
				"Could not resolve absolute executable path for 'grok'. Skipping command execution.",
			);
		} else {
			const controller = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
			if (typeof timer.unref === 'function') timer.unref();

			let cmdRes: CommandExecutionResult;
			try {
				cmdRes = await options.commandRunner({
					...launch,
					timeoutMs,
					signal: controller.signal,
				});
			} catch (err) {
				cmdRes = {
					ok: false,
					exitCode: null,
					stdout: '',
					stderr: (err as Error).message ?? '',
					timedOut: controller.signal.aborted || timedOut,
				};
			} finally {
				clearTimeout(timer);
			}

			if (cmdRes.timedOut || controller.signal.aborted) {
				isPartial = true;
				warnings.push(
					`Command '${launch.file}' timed out after ${timeoutMs}ms. List may be incomplete.`,
				);
			} else if (!cmdRes.ok || (cmdRes.exitCode !== null && cmdRes.exitCode !== 0)) {
				isPartial = true;
				warnings.push(
					`Command '${launch.file}' exited with non-zero status. List may be incomplete.`,
				);
				if (cmdRes.stdout) rawStdout = cmdRes.stdout;
			} else {
				// Command succeeded: parse models from output
				const parsedCommandModels = parseGrokModelsCommandOutput(cmdRes.stdout);
				if (parsedCommandModels.length === 0 && cmdRes.stdout.trim().length > 0) {
					// Format changed! (E-39)
					isPartial = true;
					rawStdout = cmdRes.stdout;
					warnings.push('Failed to parse model list from grok output; format may have changed.');
				} else {
					for (const m of parsedCommandModels) {
						const existing = modelMap.get(m.id);
						modelMap.set(m.id, {
							...existing,
							...m,
							name: existing?.name ?? m.name,
							isDefault: existing?.isDefault || m.isDefault,
						});
					}
				}
			}
		}
	}

	// 3. Merge cachedModels
	if (options.cachedModels) {
		for (const item of options.cachedModels) {
			const id = typeof item === 'string' ? item : item.id;
			if (id && !modelMap.has(id)) {
				modelMap.set(id, typeof item === 'string' ? { id } : item);
			}
		}
	}

	// 4. Merge historicalModels
	if (options.historicalModels) {
		for (const id of options.historicalModels) {
			if (id && !modelMap.has(id)) {
				modelMap.set(id, { id });
			}
		}
	}

	// Ensure currentConfigModel is marked default if present
	if (currentConfigModel) {
		const existing = modelMap.get(currentConfigModel);
		if (existing) {
			modelMap.set(currentConfigModel, { ...existing, isDefault: true });
		} else {
			modelMap.set(currentConfigModel, { id: currentConfigModel, isDefault: true });
		}
	}

	return Object.freeze({
		models: Object.freeze(Array.from(modelMap.values())),
		currentConfigModel,
		currentConfigEffort: null,
		isPartial,
		warnings: Object.freeze(warnings),
		rawStdout,
		configError,
		configErrors: configError ? Object.freeze([configError]) : Object.freeze([]),
		mtimeMs,
	});
}

function platformHostInputs(input: ReadGrokModelsOptions['hostInputs']): PlatformHostInputs | null {
	if (input?.platform !== 'win32' && input?.platform !== 'darwin' && input?.platform !== 'linux') {
		return null;
	}
	return input as PlatformHostInputs;
}

function buildCommandLaunch(
	executable: ResolvedExecutable,
	rawArgs: readonly string[],
): Pick<AbsoluteCommandLaunchSpec, 'file' | 'args' | 'windowsVerbatimArguments'> | null {
	if (executable.launchKind === 'direct') {
		return Object.freeze({
			file: executable.file,
			args: Object.freeze([...executable.argsPrefix, ...rawArgs]),
		});
	}
	const wrapped = wrapForComSpec(executable.sourcePath, rawArgs, executable.file);
	return wrapped.ok
		? Object.freeze({
				file: wrapped.launch.file,
				args: wrapped.launch.args,
				windowsVerbatimArguments: true as const,
			})
		: null;
}

export { readGrokModels as readModels };
