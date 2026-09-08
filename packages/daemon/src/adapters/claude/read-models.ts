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

export interface ReadClaudeModelsOptions {
	readonly configPath?: string;
	readonly homedir?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
}

/**
 * Reads model catalog for Claude agent from ~/.claude/settings.json.
 * Handles missing/damaged config without crashing (E-43).
 * Preserves both aliases and full IDs as distinct options (E-45).
 * Reads mtime on every call (E-44).
 */
export async function readClaudeModels(
	options: ReadClaudeModelsOptions = {},
): Promise<ReadModelsResult> {
	const homedirPath = options.homedir ?? osHomedir();
	const configPath = resolve(options.configPath ?? join(homedirPath, '.claude', 'settings.json'));

	const warnings: string[] = [];
	let currentConfigModel: string | null = null;
	let configError: ConfigErrorInfo | undefined;
	let mtimeMs: number | null = null;
	const modelMap = new Map<string, ModelOption>();

	if (!existsSync(configPath)) {
		configError = Object.freeze({
			path: configPath,
			error: 'Config file does not exist',
		});
		warnings.push(`Claude settings file does not exist at ${configPath}`);
	} else {
		try {
			const stat = statSync(configPath);
			mtimeMs = stat.mtimeMs;
			const content = readFileSync(configPath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, unknown>;

			if (typeof parsed.model === 'string' && parsed.model.trim()) {
				currentConfigModel = parsed.model.trim();
				modelMap.set(currentConfigModel, {
					id: currentConfigModel,
					isDefault: true,
				});
			}

			// Extract models from env object
			if (parsed.env && typeof parsed.env === 'object') {
				const env = parsed.env as Record<string, unknown>;

				const envModelKeys = [
					'ANTHROPIC_MODEL',
					'ANTHROPIC_DEFAULT_HAIKU_MODEL',
					'ANTHROPIC_DEFAULT_OPUS_MODEL',
					'ANTHROPIC_DEFAULT_SONNET_MODEL',
				] as const;

				for (const key of envModelKeys) {
					const val = env[key];
					if (typeof val === 'string' && val.trim()) {
						const id = val.trim();
						if (!modelMap.has(id)) {
							modelMap.set(id, { id });
						}
					}
				}
			}

			// Extract models from explicit models array if present
			if (Array.isArray(parsed.models)) {
				for (const item of parsed.models) {
					if (typeof item === 'string' && item.trim()) {
						const id = item.trim();
						if (!modelMap.has(id)) modelMap.set(id, { id });
					} else if (item && typeof item === 'object') {
						const obj = item as Record<string, unknown>;
						const id = typeof obj.id === 'string' ? obj.id.trim() : null;
						if (id && !modelMap.has(id)) {
							const name = typeof obj.name === 'string' ? obj.name : undefined;
							const description = typeof obj.description === 'string' ? obj.description : undefined;
							modelMap.set(id, { id, name, description });
						}
					}
				}
			}
		} catch (err) {
			const errorMsg = (err as Error).message;
			configError = Object.freeze({
				path: configPath,
				error: errorMsg,
			});
			warnings.push(`Failed to parse Claude settings at ${configPath}: ${errorMsg}`);
			currentConfigModel = null;
		}
	}

	// Merge cachedModels
	if (options.cachedModels) {
		for (const item of options.cachedModels) {
			const id = typeof item === 'string' ? item : item.id;
			if (id && !modelMap.has(id)) {
				modelMap.set(id, typeof item === 'string' ? { id } : item);
			}
		}
	}

	// Merge historicalModels
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
		isPartial: false,
		warnings: Object.freeze(warnings),
		configError,
		mtimeMs,
	});
}

export { readClaudeModels as readModels };
