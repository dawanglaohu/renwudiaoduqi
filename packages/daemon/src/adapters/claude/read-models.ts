import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PlatformHostInputs } from '../../platform/contract.ts';

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

export interface ReadClaudeModelsOptions {
	readonly hostInputs?:
		| PlatformHostInputs
		| { readonly homedir: string; readonly platform?: string };
	readonly homedir?: string;
	readonly configPath?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
	readonly fs?: ModelReaderFileSystem;
}

/**
 * Reads model catalog for Claude agent from ~/.claude/settings.json.
 * Receives host snapshot inputs and an asynchronous, replaceable file-system capability.
 * Handles missing/damaged config without crashing (E-43).
 * Preserves both aliases and full IDs as distinct options (E-45).
 * Reads mtime on every call (E-44).
 */
export async function readClaudeModels(
	options: ReadClaudeModelsOptions = {},
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
		options.configPath ?? join(homedirPath as string, '.claude', 'settings.json'),
	);

	const warnings: string[] = [];
	let currentConfigModel: string | null = null;
	let configError: ConfigErrorInfo | undefined;
	let mtimeMs: number | null = null;
	const modelMap = new Map<string, ModelOption>();

	try {
		const stat = await fs.stat(configPath);
		mtimeMs = stat.mtimeMs;
		const content = await fs.readFile(configPath, 'utf8');
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
		const errorObj = err as { code?: string; message?: string };
		const isNotFound = errorObj.code === 'ENOENT';
		const errorMsg = isNotFound
			? 'Config file does not exist'
			: (errorObj.message ?? 'Unknown read error');
		configError = Object.freeze({
			path: configPath,
			error: errorMsg,
		});
		warnings.push(`Failed to read Claude settings at ${configPath}: ${errorMsg}`);
		currentConfigModel = null;
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
		configErrors: configError ? Object.freeze([configError]) : Object.freeze([]),
		mtimeMs,
	});
}

export { readClaudeModels as readModels };
