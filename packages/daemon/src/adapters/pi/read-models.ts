import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { PlatformHostInputs } from '../../platform/contract.ts';
import { resolveExecutable } from '../../platform/resolve-executable.ts';

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
	readonly isPartial: boolean;
	readonly warnings: readonly string[];
	readonly rawStdout?: string;
	readonly configError?: ConfigErrorInfo;
	readonly configErrors?: readonly ConfigErrorInfo[];
	readonly mtimeMs?: number | null;
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
}

export interface CommandExecutionResult {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export type CommandRunner = (spec: AbsoluteCommandLaunchSpec) => Promise<CommandExecutionResult>;

export interface ReadPiModelsOptions {
	readonly hostInputs?:
		| PlatformHostInputs
		| { readonly homedir: string; readonly platform?: string };
	readonly homedir?: string;
	readonly configPath?: string;
	readonly modelsPath?: string;
	readonly storePath?: string;
	readonly settingsPath?: string;
	readonly executablePath?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
	readonly commandRunner?: CommandRunner;
	readonly timeoutMs?: number;
	readonly allowCommand?: boolean;
	readonly fs?: ModelReaderFileSystem;
}

/**
 * Extracts models from pi CLI command output.
 * Matches lines like:
 *   - provider/model-id
 *   - model-id
 *   * model-id
 */
export function parsePiModelsCommandOutput(stdout: string): ModelOption[] {
	const models: ModelOption[] = [];
	const lines = stdout.split(/\r?\n/);
	const modelLineRegex = /^\s*[*•-]\s*([a-zA-Z0-9_./:-]+)(?:\s*\(([^)]+)\))?/;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		const match = line.match(modelLineRegex);
		if (match && match[1] !== undefined) {
			const id = match[1].trim();
			const tag = match[2]?.trim().toLowerCase();
			const isDefault = tag?.includes('default') ?? false;
			models.push({ id, isDefault });
		} else {
			const singleModelMatch = line.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/);
			if (singleModelMatch && singleModelMatch[1] !== undefined) {
				models.push({ id: singleModelMatch[1].trim() });
			}
		}
	}

	return models;
}

/**
 * Parses models from Pi's models.json structure.
 * Supports:
 *   - { providers: { [p]: { models: [...] } } }
 *   - { [p]: { models: [...] } }
 *   - { models: [...] }
 *   - Array of models: [...]
 * Valid empty catalogs (e.g. { providers: {} }, { models: [] }, [], {}) return [] (R4).
 * Returns null only if structure is unrecognized and non-empty (E-90 parser failure).
 */
export function parsePiModelsJson(json: unknown): ModelOption[] | null {
	if (!json || typeof json !== 'object') return null;

	const extracted: ModelOption[] = [];

	// Top-level array: [ { id: "..." }, ... ] or []
	if (Array.isArray(json)) {
		for (const item of json) {
			const m = parseModelItem(item);
			if (m) extracted.push(m);
		}
		// A JSON array is a recognized structure, even if empty [] (R4)
		return extracted;
	}

	const obj = json as Record<string, unknown>;

	// 1. Check obj.providers: { [p]: { models: [...] } } or { providers: {} }
	if ('providers' in obj && obj.providers && typeof obj.providers === 'object') {
		const providers = obj.providers as Record<string, unknown>;
		for (const [providerKey, providerVal] of Object.entries(providers)) {
			if (providerVal && typeof providerVal === 'object') {
				const pObj = providerVal as Record<string, unknown>;
				if (Array.isArray(pObj.models)) {
					for (const item of pObj.models) {
						const m = parseModelItem(item, providerKey);
						if (m) extracted.push(m);
					}
				}
			}
		}
		// Recognized structure, even when providers is {} or empty models (R4)
		return extracted;
	}

	// 2. Check top-level obj.models: [...]
	if ('models' in obj && Array.isArray(obj.models)) {
		for (const item of obj.models) {
			const m = parseModelItem(item);
			if (m) extracted.push(m);
		}
		// Recognized structure, even if empty [] (R4)
		return extracted;
	}

	// 3. Check direct provider map: { "antigravity": { models: [...] } }
	const keys = Object.keys(obj);
	if (keys.length === 0) {
		// Empty object {} is a valid empty catalog (R4)
		return extracted;
	}

	let hasRecognizedProviderMap = false;
	for (const [key, val] of Object.entries(obj)) {
		if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).models)) {
			hasRecognizedProviderMap = true;
			const pObj = val as Record<string, unknown>;
			for (const item of pObj.models as unknown[]) {
				const m = parseModelItem(item, key);
				if (m) extracted.push(m);
			}
		}
	}
	if (hasRecognizedProviderMap) {
		return extracted;
	}

	// Unrecognized/corrupted structure that is not an empty catalog (E-90)
	return null;
}

function parseModelItem(item: unknown, _provider?: string): ModelOption | null {
	if (typeof item === 'string' && item.trim()) {
		return { id: item.trim() };
	}
	if (item && typeof item === 'object') {
		const obj = item as Record<string, unknown>;
		const id =
			typeof obj.id === 'string'
				? obj.id.trim()
				: typeof obj.slug === 'string'
					? obj.slug.trim()
					: null;
		if (id) {
			const name =
				typeof obj.name === 'string'
					? obj.name.trim()
					: typeof obj.display_name === 'string'
						? obj.display_name.trim()
						: undefined;
			const description = typeof obj.description === 'string' ? obj.description.trim() : undefined;
			return { id, name, description };
		}
	}
	return null;
}

/**
 * Reads model catalog for Pi agent from ~/.pi/agent/models.json, models-store.json, settings.json,
 * and optional `pi --models` CLI command.
 * Strictly identifies missing/damaged files and returns specific absolute paths (R1).
 * Hard ceiling 5000ms timeout with absolute launch object and cancellable AbortSignal (R2).
 * Receives host snapshot inputs and async file system capability (R3).
 * Treats {providers:{}} or empty models as valid empty catalog without parser failure (R4).
 * Reads mtime on every call (E-44).
 */
export async function readPiModels(options: ReadPiModelsOptions = {}): Promise<ReadModelsResult> {
	const fs = options.fs ?? DEFAULT_MODEL_FILE_SYSTEM;
	const homedirPath = options.hostInputs?.homedir ?? options.homedir;

	if (!options.configPath && !options.modelsPath && !homedirPath) {
		return Object.freeze({
			models: Object.freeze([]),
			currentConfigModel: null,
			isPartial: false,
			warnings: Object.freeze(['Neither modelsPath nor hostInputs.homedir was provided.']),
			configError: Object.freeze({
				path: '',
				error: 'Host snapshot with homedir or modelsPath is required',
			}),
			mtimeMs: null,
		});
	}

	const piDir = join(homedirPath ?? '', '.pi', 'agent');
	const modelsPath = resolve(
		options.modelsPath ?? options.configPath ?? join(piDir, 'models.json'),
	);
	const storePath = resolve(options.storePath ?? join(piDir, 'models-store.json'));
	const settingsPath = resolve(options.settingsPath ?? join(piDir, 'settings.json'));
	// Hard cap 5000ms timeout that cannot be enlarged (R2)
	const timeoutMs = Math.max(
		1,
		Math.min(options.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS),
	);

	const warnings: string[] = [];
	const configErrors: ConfigErrorInfo[] = [];
	let currentConfigModel: string | null = null;
	let mtimeMs: number | null = null;
	let isPartial = false;
	let rawStdout: string | undefined;
	const modelMap = new Map<string, ModelOption>();

	// 1. Read settings.json for defaultModel asynchronously (R1: do NOT empty-catch syntax errors)
	try {
		const stat = await fs.stat(settingsPath);
		if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
		const content = await fs.readFile(settingsPath, 'utf8');
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			if (typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim()) {
				currentConfigModel = parsed.defaultModel.trim();
				modelMap.set(currentConfigModel, { id: currentConfigModel, isDefault: true });
			}
		} catch (err) {
			const errorMsg = (err as Error).message;
			configErrors.push(
				Object.freeze({
					path: settingsPath,
					error: `Invalid JSON in settings: ${errorMsg}`,
				}),
			);
			warnings.push(`Failed to parse Pi settings.json at ${settingsPath}: ${errorMsg}`);
		}
	} catch (err) {
		const errorObj = err as { code?: string; message?: string };
		if (errorObj.code !== 'ENOENT') {
			configErrors.push(
				Object.freeze({
					path: settingsPath,
					error: errorObj.message ?? 'Unknown read error',
				}),
			);
			warnings.push(`Failed to read Pi settings.json at ${settingsPath}: ${errorObj.message}`);
		}
	}

	// 2. Read models.json asynchronously (R1: return absolute path on failure)
	try {
		const stat = await fs.stat(modelsPath);
		if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
		const content = await fs.readFile(modelsPath, 'utf8');
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (err) {
			const errorMsg = (err as Error).message;
			configErrors.push(
				Object.freeze({
					path: modelsPath,
					error: `Invalid JSON: ${errorMsg}`,
				}),
			);
			warnings.push(`Failed to parse Pi models.json at ${modelsPath}: ${errorMsg}`);
		}

		if (parsed !== undefined) {
			const modelsFromJson = parsePiModelsJson(parsed);
			if (modelsFromJson === null) {
				// Parser failure: models.json structure changed (E-90)
				isPartial = true;
				warnings.push(
					`Failed to parse models.json structure at ${modelsPath}; structure may have changed.`,
				);
			} else {
				for (const m of modelsFromJson) {
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
	} catch (err) {
		const errorObj = err as { code?: string; message?: string };
		const isNotFound = errorObj.code === 'ENOENT';
		const errorMsg = isNotFound
			? 'Config file does not exist'
			: (errorObj.message ?? 'Unknown read error');
		configErrors.push(
			Object.freeze({
				path: modelsPath,
				error: errorMsg,
			}),
		);
		warnings.push(`Failed to read Pi models.json at ${modelsPath}: ${errorMsg}`);
	}

	// 3. Read models-store.json asynchronously (R1: do NOT empty-catch syntax errors)
	try {
		const stat = await fs.stat(storePath);
		if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
		const content = await fs.readFile(storePath, 'utf8');
		try {
			const parsed = JSON.parse(content) as unknown;
			const storeModels = parsePiModelsJson(parsed);
			if (storeModels) {
				for (const m of storeModels) {
					const existing = modelMap.get(m.id);
					modelMap.set(m.id, {
						...existing,
						...m,
						name: existing?.name ?? m.name,
						isDefault: existing?.isDefault || m.isDefault,
					});
				}
			}
		} catch (err) {
			const errorMsg = (err as Error).message;
			configErrors.push(
				Object.freeze({
					path: storePath,
					error: `Invalid JSON in models-store: ${errorMsg}`,
				}),
			);
			warnings.push(`Failed to parse Pi models-store.json at ${storePath}: ${errorMsg}`);
		}
	} catch (err) {
		const errorObj = err as { code?: string; message?: string };
		if (errorObj.code !== 'ENOENT') {
			configErrors.push(
				Object.freeze({
					path: storePath,
					error: errorObj.message ?? 'Unknown read error',
				}),
			);
			warnings.push(`Failed to read Pi models-store.json at ${storePath}: ${errorObj.message}`);
		}
	}

	// 4. Run `pi --models` command via absolute launch object (R2)
	if (options.commandRunner && options.allowCommand !== false) {
		let launchFile: string | null = null;
		let launchArgsPrefix: readonly string[] = [];

		if (options.executablePath && isAbsolute(options.executablePath)) {
			launchFile = options.executablePath;
		} else if (options.hostInputs && 'platform' in options.hostInputs) {
			const resolved = await resolveExecutable(
				{
					hostInputs: options.hostInputs as PlatformHostInputs,
					executableName: 'pi',
					configuredPath: options.executablePath,
				},
				options.fs as unknown as import('../../platform/contract.ts').ExecutableFileSystem,
			);
			if (resolved.ok) {
				launchFile = resolved.executable.file;
				launchArgsPrefix = resolved.executable.argsPrefix;
			}
		}

		if (!launchFile) {
			isPartial = true;
			warnings.push(
				"Could not resolve absolute executable path for 'pi'. Skipping command execution.",
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
					file: launchFile,
					args: Object.freeze([...launchArgsPrefix, '--models']),
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
					`Command '${launchFile}' timed out after ${timeoutMs}ms. List may be incomplete.`,
				);
			} else if (!cmdRes.ok || (cmdRes.exitCode !== null && cmdRes.exitCode !== 0)) {
				isPartial = true;
				warnings.push(
					`Command '${launchFile}' exited with non-zero status. List may be incomplete.`,
				);
				if (cmdRes.stdout) rawStdout = cmdRes.stdout;
			} else {
				// Command succeeded: parse models from output
				const parsedCommandModels = parsePiModelsCommandOutput(cmdRes.stdout);
				if (parsedCommandModels.length === 0 && cmdRes.stdout.trim().length > 0) {
					// Format changed! (E-39)
					isPartial = true;
					rawStdout = cmdRes.stdout;
					warnings.push('Failed to parse model list from pi output; format may have changed.');
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

	// 5. Merge cachedModels (critical for E-90 when parser failed!)
	if (options.cachedModels) {
		for (const item of options.cachedModels) {
			const id = typeof item === 'string' ? item : item.id;
			if (id && !modelMap.has(id)) {
				modelMap.set(id, typeof item === 'string' ? { id } : item);
			}
		}
	}

	// 6. Merge historicalModels (for E-38 / E-39 downgrade)
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

	const primaryError = configErrors[0];

	return Object.freeze({
		models: Object.freeze(Array.from(modelMap.values())),
		currentConfigModel,
		isPartial,
		warnings: Object.freeze(warnings),
		rawStdout,
		configError: primaryError,
		configErrors: Object.freeze(configErrors),
		mtimeMs,
	});
}

export { readPiModels as readModels };
