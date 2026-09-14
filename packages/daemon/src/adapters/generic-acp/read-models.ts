export interface ModelOption {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly isDefault?: boolean;
}

export interface ReadModelsResult {
	readonly models: readonly ModelOption[];
	readonly currentConfigModel: string | null;
	readonly isPartial: boolean;
	readonly warnings: readonly string[];
	readonly rawStdout?: string;
	readonly mtimeMs?: number | null;
}

export interface ReadGenericAcpModelsOptions {
	readonly defaultModel?: string | null;
	readonly availableModels?: readonly string[];
	readonly historicalModels?: readonly string[];
}

/**
 * Reads available models for Generic ACP agents.
 * ACP v1 does not specify a portable CLI model-listing method.
 * Models are populated from explicit agent configuration, defaults, or historical runs.
 */
export async function readGenericAcpModels(
	options: ReadGenericAcpModelsOptions = {},
): Promise<ReadModelsResult> {
	const discoveredModels: ModelOption[] = [];

	if (options.defaultModel && options.defaultModel.trim().length > 0) {
		const id = options.defaultModel.trim();
		discoveredModels.push({
			id,
			name: id,
			isDefault: true,
		});
	}

	if (options.availableModels && options.availableModels.length > 0) {
		for (const model of options.availableModels) {
			const id = model.trim();
			if (id.length > 0 && !discoveredModels.some((m) => m.id === id)) {
				discoveredModels.push({ id, name: id });
			}
		}
	}

	if (options.historicalModels && options.historicalModels.length > 0) {
		for (const hist of options.historicalModels) {
			const id = hist.trim();
			if (id.length > 0 && !discoveredModels.some((m) => m.id === id)) {
				discoveredModels.push({ id, name: id });
			}
		}
	}

	return Object.freeze({
		models: Object.freeze(discoveredModels),
		currentConfigModel: options.defaultModel ?? null,
		isPartial: false,
		warnings: Object.freeze([]),
	});
}

export { readGenericAcpModels as readModels };
