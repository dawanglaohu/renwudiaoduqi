import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join, resolve } from 'node:path';

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
	readonly mtimeMs?: number | null;
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface ReadPiModelsOptions {
	readonly configPath?: string;
	readonly modelsPath?: string;
	readonly storePath?: string;
	readonly settingsPath?: string;
	readonly homedir?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
	readonly commandRunner?: CommandRunner;
	readonly timeoutMs?: number;
	readonly allowCommand?: boolean;
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
 * Returns null if structure is unrecognized (E-90).
 */
export function parsePiModelsJson(json: unknown): ModelOption[] | null {
	if (!json || typeof json !== 'object') return null;

	const extracted: ModelOption[] = [];

	// Top-level array: [ { id: "..." }, ... ]
	if (Array.isArray(json)) {
		for (const item of json) {
			const m = parseModelItem(item);
			if (m) extracted.push(m);
		}
		return extracted.length > 0 ? extracted : null;
	}

	const obj = json as Record<string, unknown>;

	// 1. Check obj.providers: { [p]: { models: [...] } }
	if (obj.providers && typeof obj.providers === 'object') {
		let foundProviders = false;
		const providers = obj.providers as Record<string, unknown>;
		for (const [providerKey, providerVal] of Object.entries(providers)) {
			if (providerVal && typeof providerVal === 'object') {
				foundProviders = true;
				const pObj = providerVal as Record<string, unknown>;
				if (Array.isArray(pObj.models)) {
					for (const item of pObj.models) {
						const m = parseModelItem(item, providerKey);
						if (m) extracted.push(m);
					}
				}
			}
		}
		if (foundProviders) return extracted;
	}

	// 2. Check top-level obj.models: [...]
	if (Array.isArray(obj.models)) {
		for (const item of obj.models) {
			const m = parseModelItem(item);
			if (m) extracted.push(m);
		}
		return extracted;
	}

	// 3. Check direct provider map: { "antigravity": { models: [...] } }
	let foundMap = false;
	for (const [key, val] of Object.entries(obj)) {
		if (val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).models)) {
			foundMap = true;
			const pObj = val as Record<string, unknown>;
			for (const item of pObj.models as unknown[]) {
				const m = parseModelItem(item, key);
				if (m) extracted.push(m);
			}
		}
	}
	if (foundMap) return extracted;

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
 * If command times out (> 5s) or fails with non-zero exit code:
 *   downgrades to config current + historical + manual and marks isPartial (E-38).
 * If output format changes and cannot be parsed:
 *   downgrades and retains raw stdout (E-39).
 * If models.json structure changes and cannot be parsed:
 *   downgrades and preserves cachedModels (E-90).
 * If config is missing or damaged:
 *   returns no config value without crashing (E-43).
 * Reads mtime on every call (E-44).
 */
export async function readPiModels(options: ReadPiModelsOptions = {}): Promise<ReadModelsResult> {
	const homedirPath = options.homedir ?? osHomedir();
	const piDir = join(homedirPath, '.pi', 'agent');
	const modelsPath = resolve(
		options.modelsPath ?? options.configPath ?? join(piDir, 'models.json'),
	);
	const storePath = resolve(options.storePath ?? join(piDir, 'models-store.json'));
	const settingsPath = resolve(options.settingsPath ?? join(piDir, 'settings.json'));
	const timeoutMs = options.timeoutMs ?? 5000;

	const warnings: string[] = [];
	let currentConfigModel: string | null = null;
	let configError: ConfigErrorInfo | undefined;
	let mtimeMs: number | null = null;
	let isPartial = false;
	let rawStdout: string | undefined;
	const modelMap = new Map<string, ModelOption>();

	// 1. Read settings.json for defaultModel
	if (existsSync(settingsPath)) {
		try {
			const stat = statSync(settingsPath);
			if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
			const content = readFileSync(settingsPath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, unknown>;
			if (typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim()) {
				currentConfigModel = parsed.defaultModel.trim();
				modelMap.set(currentConfigModel, { id: currentConfigModel, isDefault: true });
			}
		} catch {
			// Non-fatal for settings.json
		}
	}

	// 2. Read models.json
	if (!existsSync(modelsPath)) {
		configError = Object.freeze({
			path: modelsPath,
			error: 'Config file does not exist',
		});
		warnings.push(`Pi models file does not exist at ${modelsPath}`);
	} else {
		try {
			const stat = statSync(modelsPath);
			if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
			const content = readFileSync(modelsPath, 'utf8');
			const parsed = JSON.parse(content) as unknown;

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
		} catch (err) {
			const errorMsg = (err as Error).message;
			configError = Object.freeze({
				path: modelsPath,
				error: errorMsg,
			});
			warnings.push(`Failed to parse Pi models.json at ${modelsPath}: ${errorMsg}`);
		}
	}

	// 3. Read models-store.json if present
	if (existsSync(storePath)) {
		try {
			const stat = statSync(storePath);
			if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
			const content = readFileSync(storePath, 'utf8');
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
		} catch {
			// Non-fatal for store
		}
	}

	// 4. Run `pi --models` command if commandRunner is provided
	if (options.commandRunner && options.allowCommand !== false) {
		let commandTimedOut = false;
		let commandFailed = false;
		let cmdStdout = '';

		try {
			const cmdPromise = options.commandRunner('pi', ['--models'], { timeoutMs });
			const timeoutPromise = new Promise<never>((_, reject) => {
				const timer = setTimeout(() => {
					commandTimedOut = true;
					reject(new Error(`Command timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				if (typeof timer.unref === 'function') timer.unref();
			});

			const res = await Promise.race([cmdPromise, timeoutPromise]);
			cmdStdout = res.stdout;
			if (res.exitCode !== 0) {
				commandFailed = true;
			}
		} catch {
			commandFailed = true;
		}

		if (commandTimedOut) {
			isPartial = true;
			warnings.push(
				`Command 'pi --models' timed out after ${timeoutMs}ms. List may be incomplete.`,
			);
		} else if (commandFailed) {
			isPartial = true;
			warnings.push("Command 'pi --models' exited with non-zero status. List may be incomplete.");
			if (cmdStdout) rawStdout = cmdStdout;
		} else {
			// Command succeeded: parse models from output
			const parsedCommandModels = parsePiModelsCommandOutput(cmdStdout);
			if (parsedCommandModels.length === 0 && cmdStdout.trim().length > 0) {
				// Format changed! (E-39)
				isPartial = true;
				rawStdout = cmdStdout;
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

	return Object.freeze({
		models: Object.freeze(Array.from(modelMap.values())),
		currentConfigModel,
		isPartial,
		warnings: Object.freeze(warnings),
		rawStdout,
		configError,
		mtimeMs,
	});
}

export { readPiModels as readModels };
