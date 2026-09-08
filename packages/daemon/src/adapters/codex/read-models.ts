import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

export interface ReadCodexModelsOptions {
	readonly configPath?: string;
	readonly cachePath?: string;
	readonly homedir?: string;
	readonly historicalModels?: readonly string[];
	readonly cachedModels?: readonly (string | ModelOption)[];
}

/**
 * Parses a subset of TOML used by Codex configuration files.
 * Supports key-value pairs, string escaping, basic tables, dotted keys, and arrays.
 * Throws SyntaxError on malformed syntax.
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

		// Table headers: [table] or [[table_array]]
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

		// Key-value pair: key = value
		const eqIdx = findEqualsIndex(line);
		if (eqIdx === -1) {
			throw new SyntaxError(`Expected '=' in TOML key-value pair: ${line}`);
		}

		const rawKey = line.slice(0, eqIdx).trim();
		let rawVal = line.slice(eqIdx + 1).trim();
		if (!rawKey) {
			throw new SyntaxError(`Missing key in TOML line: ${line}`);
		}

		// Multi-line array support: [ ... ]
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
	return trimmed;
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
 * Reads model catalog for Codex agent from ~/.codex/config.toml and models_cache.json.
 * Handles missing/damaged config without crashing (E-43).
 * Reads mtime on every call (E-44).
 */
export async function readCodexModels(
	options: ReadCodexModelsOptions = {},
): Promise<ReadModelsResult> {
	const homedirPath = options.homedir ?? osHomedir();
	const configPath = resolve(options.configPath ?? join(homedirPath, '.codex', 'config.toml'));
	const cachePath = resolve(options.cachePath ?? join(dirname(configPath), 'models_cache.json'));

	const warnings: string[] = [];
	let currentConfigModel: string | null = null;
	let configError: ConfigErrorInfo | undefined;
	let mtimeMs: number | null = null;
	const modelMap = new Map<string, ModelOption>();

	// 1. Read config.toml
	if (!existsSync(configPath)) {
		configError = Object.freeze({
			path: configPath,
			error: 'Config file does not exist',
		});
		warnings.push(`Codex config file does not exist at ${configPath}`);
	} else {
		try {
			const stat = statSync(configPath);
			mtimeMs = stat.mtimeMs;
			const content = readFileSync(configPath, 'utf8');
			const parsed = parseToml(content);

			if (typeof parsed.model === 'string' && parsed.model.trim()) {
				currentConfigModel = parsed.model.trim();
				modelMap.set(currentConfigModel, {
					id: currentConfigModel,
					isDefault: true,
				});
			}

			// Extract models from [model_providers.*]
			if (parsed.model_providers && typeof parsed.model_providers === 'object') {
				const providers = parsed.model_providers as Record<string, unknown>;
				for (const [providerId, providerVal] of Object.entries(providers)) {
					if (providerVal && typeof providerVal === 'object') {
						const provObj = providerVal as Record<string, unknown>;
						const providerName = typeof provObj.name === 'string' ? provObj.name : providerId;

						if (typeof provObj.model === 'string' && provObj.model.trim()) {
							const id = provObj.model.trim();
							if (!modelMap.has(id)) {
								modelMap.set(id, { id, name: providerName });
							}
						}
						if (Array.isArray(provObj.models)) {
							for (const m of provObj.models) {
								if (typeof m === 'string' && m.trim()) {
									const id = m.trim();
									if (!modelMap.has(id)) {
										modelMap.set(id, { id, name: providerName });
									}
								}
							}
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
			warnings.push(`Failed to parse Codex config at ${configPath}: ${errorMsg}`);
			currentConfigModel = null;
		}
	}

	// 2. Read models_cache.json if available
	if (existsSync(cachePath)) {
		try {
			const cacheContent = readFileSync(cachePath, 'utf8');
			const cacheJson = JSON.parse(cacheContent) as { models?: unknown[] };
			if (Array.isArray(cacheJson.models)) {
				for (const item of cacheJson.models) {
					if (item && typeof item === 'object') {
						const m = item as Record<string, unknown>;
						const id = typeof m.slug === 'string' ? m.slug : typeof m.id === 'string' ? m.id : null;
						if (id?.trim()) {
							const trimmedId = id.trim();
							const name =
								typeof m.display_name === 'string'
									? m.display_name
									: typeof m.name === 'string'
										? m.name
										: undefined;
							const description = typeof m.description === 'string' ? m.description : undefined;
							const existing = modelMap.get(trimmedId);
							if (!existing) {
								modelMap.set(trimmedId, { id: trimmedId, name, description });
							} else if (!existing.description && description) {
								modelMap.set(trimmedId, { ...existing, description, name: existing.name ?? name });
							}
						}
					}
				}
			}
		} catch {
			// Cache read errors are non-fatal
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
		isPartial: false,
		warnings: Object.freeze(warnings),
		configError,
		mtimeMs,
	});
}

export { readCodexModels as readModels };
