import type { SupportedPlatform } from '../../platform/contract.ts';
import { type LaunchSpec, type ManagedProcess, spawnManaged } from '../../proc/spawn.ts';

export interface LiveModelItem {
	readonly name: string;
	readonly provider?: string;
	readonly effortOptions?: readonly string[];
	readonly isDefault?: boolean;
	readonly note?: string;
}

export interface LiveFailureInfo {
	readonly reason:
		| 'rpc_error'
		| 'unparsable'
		| 'timeout'
		| 'spawn_failed'
		| 'not_supported'
		| string;
	readonly timeoutMs?: number;
	readonly message?: string;
}

export interface CodexModelListResult {
	readonly ok: boolean;
	readonly models: readonly LiveModelItem[];
	readonly failure?: LiveFailureInfo | null;
	readonly warnings: readonly string[];
}

export interface RequestModelListOptions {
	readonly file: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly platform: SupportedPlatform;
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly runner?: (options: RequestModelListOptions) => Promise<CodexModelListResult>;
}

/**
 * Requests the live model catalog from codex app-server via stdio JSON-RPC 2.0 (E-345, Criterion 2).
 * Sequence:
 *   stdin: initialize (id: 1)
 *   stdout: response (id: 1)
 *   stdin: notification initialized (no id)
 *   stdin: model/list (id: 2)
 *   stdout: response (id: 2)
 *
 * Rules:
 *   - Filters out hidden: true models
 *   - Ignores unprompted notifications (no id) and non-matching ids
 *   - When nextCursor is non-null, does not follow pagination, returns list and warns
 *   - Immediately kills process once model list is gathered
 *   - Honors timeoutMs from registry (default 10000ms)
 */
export async function requestModelList(
	options: RequestModelListOptions,
): Promise<CodexModelListResult> {
	if (options.runner) {
		return options.runner(options);
	}

	const timeoutMs = options.timeoutMs ?? 10000;
	const spawnFn = options.spawnManagedFn ?? spawnManaged;
	const args = options.args && options.args.length > 0 ? options.args : ['app-server'];

	return new Promise<CodexModelListResult>((resolve) => {
		let resolved = false;
		let step: 'awaiting_init' | 'awaiting_list' | 'done' = 'awaiting_init';
		const warnings: string[] = [];
		let managed: ManagedProcess | undefined;

		const cleanupAndResolve = (result: CodexModelListResult) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			if (managed) {
				try {
					void managed.kill().catch(() => undefined);
				} catch {
					// Ignore kill errors
				}
			}
			resolve(result);
		};

		const timer = setTimeout(() => {
			cleanupAndResolve({
				ok: false,
				models: Object.freeze([]),
				failure: { reason: 'timeout', timeoutMs },
				warnings: Object.freeze(warnings),
			});
		}, timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();

		const launchSpec: LaunchSpec = {
			runId: `codex-models-${Date.now()}`,
			file: options.file,
			args,
			cwd: options.cwd && options.cwd.length > 0 ? options.cwd : '.',
		};

		try {
			managed = spawnFn(launchSpec, {
				platform: options.platform,
				onLine: (line) => {
					if (resolved) return;
					const raw = line.text.trim();
					if (!raw || !raw.startsWith('{')) return;

					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(raw) as Record<string, unknown>;
					} catch {
						return; // Ignore non-JSON lines
					}

					// Protocol rule: Ignore notifications without id (e.g. remoteControl/status/changed)
					if (!('id' in msg) || msg.id === null || msg.id === undefined) {
						return;
					}

					if (step === 'awaiting_init') {
						if (msg.id !== 1) return;

						if (msg.error) {
							const errorObj = msg.error as Record<string, unknown>;
							cleanupAndResolve({
								ok: false,
								models: Object.freeze([]),
								failure: {
									reason: 'rpc_error',
									message:
										typeof errorObj.message === 'string' ? errorObj.message : 'initialize error',
								},
								warnings: Object.freeze(warnings),
							});
							return;
						}

						// Step 1 ok: send notification initialized, then request model/list
						step = 'awaiting_list';
						try {
							managed?.writeStdin(
								`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`,
							);
							managed?.writeStdin(
								`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })}\n`,
							);
						} catch (writeErr) {
							cleanupAndResolve({
								ok: false,
								models: Object.freeze([]),
								failure: {
									reason: 'spawn_failed',
									message: (writeErr as Error).message,
								},
								warnings: Object.freeze(warnings),
							});
						}
						return;
					}

					if (step === 'awaiting_list') {
						if (msg.id !== 2) return;

						if (msg.error) {
							const errorObj = msg.error as Record<string, unknown>;
							cleanupAndResolve({
								ok: false,
								models: Object.freeze([]),
								failure: {
									reason: 'rpc_error',
									message:
										typeof errorObj.message === 'string' ? errorObj.message : 'model/list error',
								},
								warnings: Object.freeze(warnings),
							});
							return;
						}

						const resultObj = msg.result as Record<string, unknown> | undefined;
						const rawData = resultObj?.data;
						if (!Array.isArray(rawData)) {
							cleanupAndResolve({
								ok: false,
								models: Object.freeze([]),
								failure: {
									reason: 'unparsable',
									message: 'model/list result data is not an array',
								},
								warnings: Object.freeze(warnings),
							});
							return;
						}

						const models: LiveModelItem[] = [];
						for (const item of rawData) {
							if (!item || typeof item !== 'object') continue;
							const m = item as Record<string, unknown>;
							// Protocol rule: filter out hidden: true
							if (m.hidden === true) continue;

							const modelName =
								typeof m.model === 'string'
									? m.model.trim()
									: typeof m.id === 'string'
										? m.id.trim()
										: null;
							if (!modelName) continue;

							let effortOptions: string[] | undefined;
							if (Array.isArray(m.supportedReasoningEfforts)) {
								effortOptions = [];
								for (const eff of m.supportedReasoningEfforts) {
									if (typeof eff === 'string' && eff.trim()) {
										effortOptions.push(eff.trim());
									} else if (eff && typeof eff === 'object') {
										const effObj = eff as Record<string, unknown>;
										if (
											typeof effObj.reasoningEffort === 'string' &&
											effObj.reasoningEffort.trim()
										) {
											effortOptions.push(effObj.reasoningEffort.trim());
										}
									}
								}
							}

							models.push(
								Object.freeze({
									name: modelName,
									isDefault: m.isDefault === true,
									...(effortOptions !== undefined
										? { effortOptions: Object.freeze(effortOptions) }
										: {}),
									...(typeof m.description === 'string'
										? { note: m.description }
										: typeof m.displayName === 'string'
											? { note: m.displayName }
											: {}),
								}),
							);
						}

						// Protocol rule: nextCursor non-null -> do not paginate, return list and warn
						if (resultObj?.nextCursor !== null && resultObj?.nextCursor !== undefined) {
							warnings.push('codex model/list returned nextCursor but pagination is not followed');
						}

						step = 'done';
						cleanupAndResolve({
							ok: true,
							models: Object.freeze(models),
							warnings: Object.freeze(warnings),
						});
					}
				},
				onError: (error) => {
					cleanupAndResolve({
						ok: false,
						models: Object.freeze([]),
						failure: {
							reason: 'spawn_failed',
							message: error.message,
						},
						warnings: Object.freeze(warnings),
					});
				},
				onExit: (_exitResult) => {
					if (step !== 'done') {
						cleanupAndResolve({
							ok: false,
							models: Object.freeze([]),
							failure: {
								reason: 'spawn_failed',
								message: 'codex app-server exited unexpectedly before completing model/list',
							},
							warnings: Object.freeze(warnings),
						});
					}
				},
			});

			// Send initialize request immediately
			managed.writeStdin(
				`${JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: {
						clientInfo: {
							name: 'agent-scheduler',
							title: 'Agent Scheduler',
							version: '0.1.0',
						},
					},
				})}\n`,
			);
		} catch (spawnError) {
			cleanupAndResolve({
				ok: false,
				models: Object.freeze([]),
				failure: {
					reason: 'spawn_failed',
					message: (spawnError as Error).message,
				},
				warnings: Object.freeze(warnings),
			});
		}
	});
}
