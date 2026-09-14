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

export const BUILTIN_DSH_MODELS: readonly ModelOption[] = Object.freeze([
	Object.freeze({
		id: 'deepseek-chat',
		name: 'DeepSeek Chat (V3)',
		description: 'General-purpose reasoning and conversational model',
		isDefault: true,
	}),
	Object.freeze({
		id: 'deepseek-reasoner',
		name: 'DeepSeek Reasoner (R1)',
		description: 'Specialized reasoning and chain-of-thought model',
		isDefault: false,
	}),
]);

export interface ReadDshModelsOptions {
	readonly hostInputs?:
		| PlatformHostInputs
		| { readonly homedir: string; readonly platform?: string };
	readonly homedir?: string;
	readonly configPath?: string;
	readonly cachePath?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
	readonly fs?: ModelReaderFileSystem;
}

/**
 * Reads available models for DeepSeek Harness (dsh).
 * Combines built-in models (deepseek-chat, deepseek-reasoner) with any user-configured
 * model in ~/.dsh/config.json and historical models.
 */
export async function readDshModels(options: ReadDshModelsOptions = {}): Promise<ReadModelsResult> {
	const fileSystem = options.fs ?? DEFAULT_MODEL_FILE_SYSTEM;
	const homedir = options.homedir ?? options.hostInputs?.homedir ?? '';

	const configPath =
		options.configPath ?? (homedir ? resolve(join(homedir, '.dsh', 'config.json')) : undefined);

	let currentConfigModel: string | null = null;
	const warnings: string[] = [];
	const discoveredModels: ModelOption[] = [...BUILTIN_DSH_MODELS];
	let mtimeMs: number | null = null;
	let configError: ConfigErrorInfo | undefined;

	if (configPath) {
		try {
			const stat = await fileSystem.stat(configPath);
			mtimeMs = stat.mtimeMs;
			const content = await fileSystem.readFile(configPath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, unknown>;

			if (typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
				currentConfigModel = parsed.model.trim();
			} else if (
				typeof parsed.default_model === 'string' &&
				parsed.default_model.trim().length > 0
			) {
				currentConfigModel = parsed.default_model.trim();
			}

			if (Array.isArray(parsed.models)) {
				for (const item of parsed.models) {
					if (typeof item === 'string' && item.trim().length > 0) {
						const id = item.trim();
						if (!discoveredModels.some((m) => m.id === id)) {
							discoveredModels.push({ id, name: id });
						}
					}
				}
			}
		} catch (err: unknown) {
			const isEnoent =
				typeof err === 'object' &&
				err !== null &&
				'code' in err &&
				(err as { code: string }).code === 'ENOENT';
			if (!isEnoent) {
				configError = {
					path: configPath,
					error: err instanceof Error ? err.message : String(err),
				};
				warnings.push(`Failed to read dsh config at ${configPath}: ${configError.error}`);
			}
		}
	}

	if (currentConfigModel && !discoveredModels.some((m) => m.id === currentConfigModel)) {
		discoveredModels.unshift({
			id: currentConfigModel,
			name: currentConfigModel,
			isDefault: true,
		});
	}

	if (options.historicalModels && options.historicalModels.length > 0) {
		for (const hist of options.historicalModels) {
			const trimmed = hist.trim();
			if (trimmed.length > 0 && !discoveredModels.some((m) => m.id === trimmed)) {
				discoveredModels.push({ id: trimmed, name: trimmed });
			}
		}
	}

	return Object.freeze({
		models: Object.freeze(discoveredModels),
		currentConfigModel,
		isPartial: false,
		warnings: Object.freeze(warnings),
		configError,
		mtimeMs,
	});
}

export { readDshModels as readModels };
