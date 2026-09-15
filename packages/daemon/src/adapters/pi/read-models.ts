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

export interface ReadModelsResult {
	readonly models: readonly ModelOption[];
	readonly currentConfigModel: string | null;
	readonly currentConfigEffort?: EffortValue;
	readonly currentConfigProvider?: string | null;
	readonly providers?: readonly string[];
	readonly isPartial: boolean;
	readonly warnings: readonly string[];
	readonly rawStdout?: string;
	readonly configError?: ConfigErrorInfo;
	readonly configErrors?: readonly ConfigErrorInfo[];
	readonly mtimeMs?: number | null;
}

export const PI_EFFORT_OPTIONS = Object.freeze([
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const);

export function normalizeHistoryModelName(name: string): string {
	const colonIdx = name.lastIndexOf(':');
	if (colonIdx > 0 && colonIdx > name.lastIndexOf('/')) {
		return name.slice(0, colonIdx);
	}
	return name;
}

export function parsePiListModelsTable(stdout: string): (ModelOption & {
	readonly provider?: string;
	readonly effortOptions?: readonly string[];
})[] {
	const models: (ModelOption & {
		readonly provider?: string;
		readonly effortOptions?: readonly string[];
	})[] = [];
	const lines = stdout.split(/\r?\n/);
	let isTable = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		if (/^provider\s+model\b/i.test(line)) {
			isTable = true;
			continue;
		}

		if (isTable) {
			const parts = line.split(/\s+/);
			if (parts.length >= 2) {
				const provider = parts[0];
				const model = parts[1];
				const id = `${provider}/${model}`;
				const thinking = parts[4]?.toLowerCase();
				const hasThinking = thinking === 'yes';
				const effortOptions = hasThinking ? PI_EFFORT_OPTIONS : undefined;
				models.push({
					id,
					name: model,
					provider,
					effortOptions,
				});
				continue;
			}
		}

		const bulletMatch = line.match(/^\s*[*•-]\s*([a-zA-Z0-9_./:-]+)(?:\s*\(([^)]+)\))?/);
		if (bulletMatch && bulletMatch[1] !== undefined) {
			const rawId = bulletMatch[1].trim();
			const tag = bulletMatch[2]?.trim().toLowerCase();
			const isDefault = tag?.includes('default') ?? false;
			const provider = rawId.includes('/') ? rawId.split('/')[0] : undefined;
			models.push({ id: rawId, isDefault, provider, effortOptions: PI_EFFORT_OPTIONS });
		} else {
			const singleModelMatch = line.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)$/);
			if (singleModelMatch && singleModelMatch[1] !== undefined) {
				const rawId = singleModelMatch[1].trim();
				const provider = rawId.split('/')[0];
				models.push({ id: rawId, provider, effortOptions: PI_EFFORT_OPTIONS });
			}
		}
	}

	return models;
}

export const parsePiModelsCommandOutput = parsePiListModelsTable;

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

export type CommandRunner = (spec: AbsoluteCommandLaunchSpec) => Promise<CommandExecutionResult>;

export type ExecutableResolver = (
	input: ResolveExecutableInput,
) => Promise<ResolveExecutableResult>;

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
	readonly resolveExecutable?: ExecutableResolver;
}

/**
 * Parses models from Pi's models.json structure.
 * Supports:
 *   - { providers: { [p]: { models: [...] } } }
 *   - { [p]: { models: [...] } }
 *   - { models: [...] }
 *   - Array of models: [...]
 * Valid empty catalogs such as { providers: {} }, { models: [] }, [], and {} return [].
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
		// An empty array is a valid installed-but-unconfigured catalog.
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
		// An empty providers object is a valid installed-but-unconfigured catalog.
		return extracted;
	}

	// 2. Check top-level obj.models: [...]
	if ('models' in obj && Array.isArray(obj.models)) {
		for (const item of obj.models) {
			const m = parseModelItem(item);
			if (m) extracted.push(m);
		}
		// An empty models array is a valid installed-but-unconfigured catalog.
		return extracted;
	}

	// 3. Check direct provider map: { "antigravity": { models: [...] } }
	const keys = Object.keys(obj);
	if (keys.length === 0) {
		// An empty object is a valid installed-but-unconfigured catalog.
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
 * Identifies each missing or damaged file and returns its absolute path.
 * Runs the list command through an absolute launch object with a 5000ms hard ceiling.
 * Receives host snapshot inputs and an asynchronous, replaceable file-system capability.
 * Treats {providers:{}} and empty model arrays as valid empty catalogs.
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
	// Callers may lower the timeout for tests or policy, but cannot enlarge the production ceiling.
	const timeoutMs = Math.max(
		1,
		Math.min(options.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS),
	);

	const warnings: string[] = [];
	const configErrors: ConfigErrorInfo[] = [];
	let currentConfigModel: string | null = null;
	let currentConfigEffort: EffortValue = null;
	let currentConfigProvider: string | null = null;
	const providersSet = new Set<string>();
	let mtimeMs: number | null = null;
	let isPartial = false;
	let rawStdout: string | undefined;
	const modelMap = new Map<string, ModelOption>();

	// 1. Read settings.json for defaultModel; every parse failure remains attributable to this path.
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
			if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.trim()) {
				currentConfigProvider = parsed.defaultProvider.trim();
				providersSet.add(currentConfigProvider);
			}
			if (typeof parsed.defaultThinkingLevel === 'string' && parsed.defaultThinkingLevel.trim()) {
				const raw = parsed.defaultThinkingLevel.trim();
				if (raw === 'low' || raw === 'medium' || raw === 'high') {
					currentConfigEffort = { tier: raw };
				} else {
					currentConfigEffort = { vendor: raw };
				}
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

	// 2. Read models.json and preserve its absolute path on failure.
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
				if (parsed && typeof parsed === 'object') {
					const obj = parsed as Record<string, unknown>;
					if (obj.providers && typeof obj.providers === 'object') {
						for (const p of Object.keys(obj.providers)) providersSet.add(p);
					}
				}
				for (const m of modelsFromJson) {
					if (m.id.includes('/')) {
						const provider = m.id.split('/')[0];
						if (provider) providersSet.add(provider);
					}
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

	// 3. Read models-store.json; every parse failure remains attributable to this path.
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

	// 4. Run `pi --models` through a fully resolved absolute launch object.
	if (options.commandRunner && options.allowCommand !== false) {
		const hostInputs = platformHostInputs(options.hostInputs);
		const resolved = hostInputs
			? await (options.resolveExecutable ?? resolvePlatformExecutable)({
					hostInputs,
					executableName: 'pi',
					configuredPath: options.executablePath,
				})
			: null;
		const launch = resolved?.ok
			? buildCommandLaunch(resolved.executable, Object.freeze(['--models']))
			: null;

		if (!launch) {
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
		currentConfigEffort,
		currentConfigProvider,
		providers: Object.freeze(Array.from(providersSet)),
		isPartial,
		warnings: Object.freeze(warnings),
		rawStdout,
		configError: primaryError,
		configErrors: Object.freeze(configErrors),
		mtimeMs,
	});
}

function platformHostInputs(input: ReadPiModelsOptions['hostInputs']): PlatformHostInputs | null {
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

export { readPiModels as readModels };
