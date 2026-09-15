import type { ResolvedAgentConfig } from '../config/defaults.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import type { spawnManaged } from '../proc/spawn.ts';
import {
	type CodexModelListResult,
	type LiveFailureInfo,
	type LiveModelItem,
	type RequestModelListOptions,
	requestModelList,
} from './codex/model-list-rpc.ts';
import { parseGrokModelsOutput } from './grok/read-models.ts';
import { parsePiListModelsTable } from './pi/read-models.ts';
import {
	type CommandRunnerParams,
	type CommandRunnerResult,
	executeProbeProcess,
} from './probe.ts';

export type { LiveModelItem, LiveFailureInfo };

export interface LiveModelCatalogResult {
	readonly ok: boolean;
	readonly models: readonly LiveModelItem[];
	readonly failure?: LiveFailureInfo | null;
	readonly warnings: readonly string[];
}

export interface ReadModelsLiveParams {
	readonly agentId: string;
	readonly config: ResolvedAgentConfig;
	readonly resolvedPath: string | null;
	readonly cwd?: string;
	readonly platform: SupportedPlatform;
	readonly commandRunner?: (params: CommandRunnerParams) => Promise<CommandRunnerResult>;
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly rpcRunner?: (options: RequestModelListOptions) => Promise<CodexModelListResult>;
}

/**
 * Dispatches live model collection according to modelsLive.kind in registry (Criterion 2, E-38, E-345).
 * - 'command': runs executeProbeProcess() with modelsLive.args and parses with modelsLive.parser
 * - 'codex_app_server': stdio JSON-RPC via requestModelList()
 * - 'none': returns ok: false, failure: { reason: 'not_supported' }
 * Timeout comes from registry modelsLive.timeoutMs (factory 5000 / codex 10000, fallback 5000, ceiling 60000).
 */
export async function readModelsLive(
	params: ReadModelsLiveParams,
): Promise<LiveModelCatalogResult> {
	const { agentId, config, resolvedPath, platform } = params;
	const liveConfig = config.modelsLive;

	if (liveConfig.kind === 'none') {
		return Object.freeze({
			ok: false,
			models: Object.freeze([]),
			failure: Object.freeze({ reason: 'not_supported' }),
			warnings: Object.freeze([]),
		});
	}

	if (!resolvedPath || resolvedPath.trim().length === 0) {
		return Object.freeze({
			ok: false,
			models: Object.freeze([]),
			failure: Object.freeze({ reason: 'exec_missing' }),
			warnings: Object.freeze([]),
		});
	}

	// Timeout clamped between 1000 and 60000ms
	const defaultTimeout = liveConfig.kind === 'codex_app_server' ? 10000 : 5000;
	const configuredTimeout = liveConfig.timeoutMs ?? defaultTimeout;
	const timeoutMs = Math.max(1000, Math.min(configuredTimeout, 60000));
	const cwd = params.cwd && params.cwd.length > 0 ? params.cwd : '.';

	if (liveConfig.kind === 'codex_app_server') {
		const rpcRes = await requestModelList({
			file: resolvedPath,
			args: liveConfig.args,
			cwd,
			timeoutMs,
			platform,
			spawnManagedFn: params.spawnManagedFn,
			runner: params.rpcRunner,
		});

		return Object.freeze({
			ok: rpcRes.ok,
			models: rpcRes.models,
			failure: rpcRes.failure ?? null,
			warnings: rpcRes.warnings,
		});
	}

	if (liveConfig.kind === 'command') {
		const execution = await executeProbeProcess({
			file: resolvedPath,
			args: liveConfig.args,
			windowsVerbatimArguments: false,
			cwd,
			timeoutMs,
			platform,
			commandRunner: params.commandRunner,
			spawnManagedFn: params.spawnManagedFn,
			agentId,
		});

		if (execution.timedOut) {
			return Object.freeze({
				ok: false,
				models: Object.freeze([]),
				failure: Object.freeze({ reason: 'timeout', timeoutMs }),
				warnings: Object.freeze([]),
			});
		}

		if (!execution.ok) {
			return Object.freeze({
				ok: false,
				models: Object.freeze([]),
				failure: Object.freeze({
					reason: 'spawn_failed',
					message: execution.stderr || execution.stdout || 'Process exited with non-zero code',
				}),
				warnings: Object.freeze([]),
			});
		}

		let items: readonly LiveModelItem[] = [];
		if (liveConfig.parser === 'pi_list_models_table') {
			const parsed = parsePiListModelsTable(execution.stdout);
			items = parsed.map((m) =>
				Object.freeze({
					name: m.id,
					provider: m.provider,
					effortOptions: m.effortOptions,
					isDefault: m.isDefault,
				}),
			);
		} else if (liveConfig.parser === 'grok_models_text') {
			const parsed = parseGrokModelsOutput(execution.stdout);
			items = parsed.map((m) =>
				Object.freeze({
					name: m.id,
					isDefault: m.isDefault,
				}),
			);
		} else {
			return Object.freeze({
				ok: false,
				models: Object.freeze([]),
				failure: Object.freeze({ reason: 'not_supported' }),
				warnings: Object.freeze([]),
			});
		}

		return Object.freeze({
			ok: true,
			models: Object.freeze(items),
			warnings: Object.freeze([]),
		});
	}

	return Object.freeze({
		ok: false,
		models: Object.freeze([]),
		failure: Object.freeze({ reason: 'not_supported' }),
		warnings: Object.freeze([]),
	});
}
