import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestModelList } from '../../src/adapters/codex/model-list-rpc.ts';
import { readModelsLive } from '../../src/adapters/models-live.ts';
import {
	normalizeHistoryModelName as normalizePiHistoryModelName,
	parsePiListModelsTable,
} from '../../src/adapters/pi/read-models.ts';
import { BUILT_IN_AGENT_DEFAULTS, type ResolvedAgentConfig } from '../../src/config/defaults.ts';
import type { AgentRegistry } from '../../src/config/registry.ts';
import { mergeModelSources } from '../../src/domain/model-catalog.ts';
import type { ExecutableFileSystem } from '../../src/platform/contract.ts';
import type { spawnManaged } from '../../src/proc/spawn.ts';
import type { RunsRepo } from '../../src/repo/runs.ts';
import { createAgentService } from '../../src/service/agents.ts';

const fixturesDir = join(__dirname, '../fixtures/models');
const loginFixturesDir = join(__dirname, '../fixtures/login');

describe('M4-T14 Live Models Catalog, Source Attribution and Effort Domain', () => {
	describe('1) Codex app-server JSON-RPC and NDJSON Session Replay (Criterion 2, E-345)', () => {
		it('replays NDJSON session, handles initialize -> initialized -> model/list, ignores notifications, filters hidden', async () => {
			const ndjsonContent = readFileSync(
				join(fixturesDir, 'codex-model-list.stdout.ndjson'),
				'utf8',
			);
			const lines = ndjsonContent.split('\n').filter((l) => l.trim().length > 0);

			const writtenToStdin: string[] = [];
			let killed = false;

			const mockManaged = {
				writeStdin: (data: string) => {
					writtenToStdin.push(data);
					return true;
				},
				kill: async () => {
					killed = true;
				},
			};

			const spawnManagedFn = ((
				_spec: unknown,
				options: { onLine: (line: { text: string }) => void },
			) => {
				// Deliver lines asynchronously
				setTimeout(() => {
					for (const line of lines) {
						options.onLine({ text: line });
					}
				}, 5);
				return mockManaged;
			}) as unknown as typeof spawnManaged;

			const result = await requestModelList({
				file: 'codex',
				platform: 'linux',
				spawnManagedFn,
			});

			expect(result.ok).toBe(true);
			expect(result.models.length).toBe(2);
			// Filtered hidden: true
			expect(result.models.some((m) => m.name === 'hidden-model')).toBe(false);

			// First model: gpt-6-astra, default, 6 effort options
			const astra = result.models.find((m) => m.name === 'gpt-6-astra');
			expect(astra).toBeDefined();
			expect(astra?.isDefault).toBe(true);
			expect(astra?.effortOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

			// Second model: gpt-5.6-sol
			const sol = result.models.find((m) => m.name === 'gpt-5.6-sol');
			expect(sol).toBeDefined();
			expect(sol?.effortOptions).toEqual(['low', 'medium', 'high', 'xhigh']);

			// Process killed after receiving list
			expect(killed).toBe(true);

			// Assert protocol write sequence: initialize -> initialized -> model/list
			expect(writtenToStdin.length).toBe(3);
			expect(writtenToStdin[0]).toContain('"initialize"');
			expect(writtenToStdin[1]).toContain('"initialized"');
			expect(writtenToStdin[2]).toContain('"model/list"');
		});

		it('handles rpc_error when model/list returns JSON-RPC error', async () => {
			const ndjsonContent = readFileSync(
				join(fixturesDir, 'codex-model-list.rpc-error.ndjson'),
				'utf8',
			);
			const lines = ndjsonContent.split('\n').filter((l) => l.trim().length > 0);

			let killed = false;
			const mockManaged = {
				writeStdin: () => true,
				kill: async () => {
					killed = true;
				},
			};

			const spawnManagedFn = ((
				_spec: unknown,
				options: { onLine: (line: { text: string }) => void },
			) => {
				setTimeout(() => {
					for (const line of lines) {
						options.onLine({ text: line });
					}
				}, 5);
				return mockManaged;
			}) as unknown as typeof spawnManaged;

			const result = await requestModelList({
				file: 'codex',
				platform: 'linux',
				spawnManagedFn,
			});

			expect(result.ok).toBe(false);
			expect(result.failure?.reason).toBe('rpc_error');
			expect(result.failure?.message).toContain('failed to fetch remote models');
			expect(killed).toBe(true);
		});

		it('does not paginate when nextCursor is non-null, returns models and warns', async () => {
			const ndjsonContent = readFileSync(
				join(fixturesDir, 'codex-model-list.pagination.ndjson'),
				'utf8',
			);
			const lines = ndjsonContent.split('\n').filter((l) => l.trim().length > 0);

			let killed = false;
			const mockManaged = {
				writeStdin: () => true,
				kill: async () => {
					killed = true;
				},
			};

			const spawnManagedFn = ((
				_spec: unknown,
				options: { onLine: (line: { text: string }) => void },
			) => {
				setTimeout(() => {
					for (const line of lines) {
						options.onLine({ text: line });
					}
				}, 5);
				return mockManaged;
			}) as unknown as typeof spawnManaged;

			const result = await requestModelList({
				file: 'codex',
				platform: 'linux',
				spawnManagedFn,
			});

			expect(result.ok).toBe(true);
			expect(result.models.length).toBe(1);
			expect(result.warnings.some((w) => w.includes('nextCursor'))).toBe(true);
			expect(killed).toBe(true);
		});

		it('kills process and returns failure on timeout', async () => {
			let killed = false;
			const mockManaged = {
				writeStdin: () => true,
				kill: async () => {
					killed = true;
				},
			};

			const spawnManagedFn = (() => mockManaged) as unknown as typeof spawnManaged;

			const result = await requestModelList({
				file: 'codex',
				platform: 'linux',
				timeoutMs: 50,
				spawnManagedFn,
			});

			expect(result.ok).toBe(false);
			expect(result.failure?.reason).toBe('timeout');
			expect(result.failure?.timeoutMs).toBe(50);
			expect(killed).toBe(true);
		});
	});

	describe('2) Command-based live probe: pi and grok (Criterion 2)', () => {
		it('parses pi --list-models table and supplies seven effort options when thinking is supported', () => {
			const stdout = readFileSync(join(loginFixturesDir, 'pi-list-models.stdout.txt'), 'utf8');
			const models = parsePiListModelsTable(stdout);

			expect(models.length).toBe(15);
			// cc-switch-deep-seek/deepseek-chat has thinking=yes -> 7 effort options
			const ds = models.find((m) => m.id === 'cc-switch-deep-seek/deepseek-chat');
			expect(ds).toBeDefined();
			expect(ds?.provider).toBe('cc-switch-deep-seek');
			expect(ds?.effortOptions).toEqual([
				'off',
				'minimal',
				'low',
				'medium',
				'high',
				'xhigh',
				'max',
			]);

			// antigravity/claude-3-5-haiku has thinking=no -> no effort options
			const haiku = models.find((m) => m.id === 'antigravity/claude-3-5-haiku-20241022');
			expect(haiku).toBeDefined();
			expect(haiku?.effortOptions).toBeUndefined();
		});

		it('returns not_supported for agents with kind: none', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.claude,
				isEnabled: true,
			} as ResolvedAgentConfig;
			const result = await readModelsLive({
				agentId: 'claude',
				config,
				resolvedPath: '/usr/bin/claude',
				platform: 'linux',
			});

			expect(result.ok).toBe(false);
			expect(result.failure?.reason).toBe('not_supported');
		});
	});

	describe('3) mergeModelSources 8 cases (Criterion 1 & 9, E-338, E-350)', () => {
		it('Case 1: Live only', () => {
			const merged = mergeModelSources({
				live: {
					ok: true,
					models: [{ name: 'm1', effortOptions: ['low', 'high'], isDefault: true }, { name: 'm2' }],
				},
				currentConfigModel: null,
				builtinModels: [],
				historyModels: [],
			});

			expect(merged.map((m) => m.name)).toEqual(['m1', 'm2']);
			expect(merged[0]?.source).toBe('live');
			expect(merged[0]?.isDefault).toBe(true);
			expect(merged[0]?.effortOptions).toEqual(['low', 'high']);
			expect(merged[0]?.isCurrentConfig).toBe(false);
		});

		it('Case 2: Config model already in live -> stays in live with isCurrentConfig: true', () => {
			const merged = mergeModelSources({
				live: {
					ok: true,
					models: [{ name: 'gpt-4o' }, { name: 'gpt-5' }],
				},
				currentConfigModel: 'gpt-4o',
				builtinModels: [],
				historyModels: [],
			});

			expect(merged.length).toBe(2);
			const gpt4 = merged.find((m) => m.name === 'gpt-4o');
			expect(gpt4?.source).toBe('live');
			expect(gpt4?.isCurrentConfig).toBe(true);
		});

		it('Case 3: Config model not in live (live ok) -> added as config, isCurrentConfig: true, note: 当前配置 · 清单未列', () => {
			const merged = mergeModelSources({
				live: {
					ok: true,
					models: [{ name: 'm1' }],
				},
				currentConfigModel: 'legacy-model',
				builtinModels: [],
				historyModels: [],
			});

			expect(merged.length).toBe(2);
			const legacy = merged.find((m) => m.name === 'legacy-model');
			expect(legacy).toBeDefined();
			expect(legacy?.source).toBe('config');
			expect(legacy?.isCurrentConfig).toBe(true);
			expect(legacy?.isDefault).toBe(true);
			expect(legacy?.note).toBe('当前配置 · 清单未列');
		});

		it('Case 4: Config present, live failed/empty -> config added, isCurrentConfig: true', () => {
			const merged = mergeModelSources({
				live: {
					ok: false,
					models: [],
				},
				currentConfigModel: 'opus[1m]',
				builtinModels: [{ name: 'opus[1m]', note: 'alias' }],
				historyModels: [],
			});

			expect(merged.length).toBe(1);
			expect(merged[0]?.name).toBe('opus[1m]');
			expect(merged[0]?.source).toBe('config');
			expect(merged[0]?.isCurrentConfig).toBe(true);
			expect(merged[0]?.note).toBe('alias');
		});

		it('Case 5: Builtin duplicate with config -> config wins, builtin deduplicated', () => {
			const merged = mergeModelSources({
				live: null,
				currentConfigModel: 'sonnet',
				builtinModels: [
					{ name: 'sonnet', note: 'builtin note' },
					{ name: 'haiku', note: 'haiku note' },
				],
				historyModels: [],
			});

			expect(merged.length).toBe(2);
			expect(merged[0]?.name).toBe('sonnet');
			expect(merged[0]?.source).toBe('config');
			expect(merged[0]?.isCurrentConfig).toBe(true);
			expect(merged[1]?.name).toBe('haiku');
			expect(merged[1]?.source).toBe('builtin');
		});

		it('Case 6: Builtin duplicate with live -> live wins, builtin deduplicated', () => {
			const merged = mergeModelSources({
				live: {
					ok: true,
					models: [{ name: 'opus' }],
				},
				currentConfigModel: null,
				builtinModels: [{ name: 'opus', note: 'alias' }, { name: 'haiku' }],
				historyModels: [],
			});

			expect(merged.length).toBe(2);
			expect(merged[0]?.name).toBe('opus');
			expect(merged[0]?.source).toBe('live');
			expect(merged[1]?.name).toBe('haiku');
			expect(merged[1]?.source).toBe('builtin');
		});

		it('Case 7: History duplicate with earlier sources -> earlier wins, history deduplicated', () => {
			const merged = mergeModelSources({
				live: {
					ok: true,
					models: [{ name: 'model-live' }],
				},
				currentConfigModel: 'model-config',
				builtinModels: [{ name: 'model-builtin' }],
				historyModels: ['model-live', 'model-config', 'model-builtin', 'model-hist-only'],
			});

			expect(merged.length).toBe(4);
			expect(merged[0]?.name).toBe('model-live');
			expect(merged[0]?.source).toBe('live');
			expect(merged[1]?.name).toBe('model-config');
			expect(merged[1]?.source).toBe('config');
			expect(merged[2]?.name).toBe('model-builtin');
			expect(merged[2]?.source).toBe('builtin');
			expect(merged[3]?.name).toBe('model-hist-only');
			expect(merged[3]?.source).toBe('history');
		});

		it('Case 8: All 4 sources with unique and overlapping entries -> strictly follows live -> config -> builtin -> history', () => {
			const merged = mergeModelSources({
				live: {
					ok: true,
					models: [{ name: 'A' }, { name: 'B' }],
				},
				currentConfigModel: 'C',
				builtinModels: [{ name: 'B' }, { name: 'D' }],
				historyModels: ['A', 'C', 'E', 'F'],
			});

			expect(merged.map((m) => `${m.name}:${m.source}`)).toEqual([
				'A:live',
				'B:live',
				'C:config',
				'D:builtin',
				'E:history',
				'F:history',
			]);
		});
	});

	describe('4) History suffix stripping and truncation (Criterion 4, E-340)', () => {
		it('pi strips :thinking suffix while preserving provider/model prefix', () => {
			expect(normalizePiHistoryModelName('antigravity/claude-opus-4-6:high')).toBe(
				'antigravity/claude-opus-4-6',
			);
			expect(normalizePiHistoryModelName('sonnet:medium')).toBe('sonnet');
			expect(normalizePiHistoryModelName('antigravity/claude-opus-4-6:xhigh')).toBe(
				'antigravity/claude-opus-4-6',
			);
			expect(normalizePiHistoryModelName('antigravity/claude-opus-4-6')).toBe(
				'antigravity/claude-opus-4-6',
			);
			expect(normalizePiHistoryModelName('plain-model')).toBe('plain-model');
		});

		it('truncates history to 20 after deduplication of 40 raw entries', async () => {
			const raw40: string[] = [];
			for (let i = 0; i < 30; i++) {
				raw40.push(`provider/model-${i}:high`);
				raw40.push(`provider/model-${i}:low`);
			}

			let queriedLimit = 0;
			const mockRunsRepo = {
				listSucceededModelNames: (params: {
					readonly agentId: string;
					readonly limit?: number;
				}) => {
					queriedLimit = params.limit ?? 0;
					return raw40;
				},
			};

			const mockRegistry = {
				start: async () => ({}),
				getSnapshot: () => ({
					generation: 1,
					storedDefaults: {
						pi: { ...BUILT_IN_AGENT_DEFAULTS.pi, execPath: '/bin/pi' },
					},
					agents: {
						pi: { ...BUILT_IN_AGENT_DEFAULTS.pi, execPath: '/bin/pi', isEnabled: true },
					},
					userOverrides: {},
				}),
				onReload: () => {},
			};

			const mockFs = {
				readUtf8File: async () => '{}',
				writeUtf8File: async () => {},
				watchDirectory: () => ({ close: () => {}, on: () => ({}) }),
				stat: async () => ({
					isFile: () => true,
					isSymbolicLink: () => false,
					mtimeMs: 1000,
					size: 2048,
				}),
				lstat: async () => ({
					isFile: () => true,
					isSymbolicLink: () => false,
					mtimeMs: 1000,
					size: 2048,
				}),
				realpath: async (p: string) => p,
				access: async () => {},
				readlink: async (p: string) => p,
				readFile: async () => '{}',
			};

			const service = createAgentService({
				registry: mockRegistry as unknown as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/test' },
				runsRepo: mockRunsRepo as unknown as RunsRepo,
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: async (params) => {
					if (params.args.includes('--version')) {
						return { ok: true, exitCode: 0, stdout: 'pi version 0.85.1', stderr: '' };
					}
					return { ok: true, exitCode: 0, stdout: '', stderr: '' };
				},
			});

			const modelsRes = await service.listAgentModels('pi');
			expect(queriedLimit).toBe(40);
			const historyItems = modelsRes.models.filter((m) => m.source === 'history');
			expect(historyItems.length).toBeLessThanOrEqual(20);
			// All stripped :thinking
			for (const h of historyItems) {
				expect(h.name).not.toContain(':');
			}
		});
	});

	describe('5) isRefreshing and in-flight deduplication (Criterion 3, E-339)', () => {
		it('returns isRefreshing: true immediately without waiting when probe is in flight and uncached', async () => {
			let resolveProbe: ((val: unknown) => void) | undefined;
			const pendingProbePromise = new Promise((res) => {
				resolveProbe = res;
			});

			const mockRegistry = {
				start: async () => ({}),
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					storedDefaults: {
						grok: { ...BUILT_IN_AGENT_DEFAULTS.grok, execPath: '/bin/grok' },
					},
					agents: {
						grok: { ...BUILT_IN_AGENT_DEFAULTS.grok, execPath: '/bin/grok', isEnabled: true },
					},
					userOverrides: {},
					builtInDefaults: BUILT_IN_AGENT_DEFAULTS,
					defaultUpdates: [],
				}),
				onReload: () => {},
			};

			const mockFs = {
				readUtf8File: async () => '{}',
				writeUtf8File: async () => {},
				watchDirectory: () => {
					const watcher = { close: () => undefined, on: () => watcher };
					return watcher;
				},
				stat: async () => ({
					isFile: () => true,
					isSymbolicLink: () => false,
					mtimeMs: 1000,
					size: 2048,
				}),
				lstat: async () => ({
					isFile: () => true,
					isSymbolicLink: () => false,
					mtimeMs: 1000,
					size: 2048,
				}),
				realpath: async (p: string) => p,
				access: async () => {},
				readlink: async (p: string) => p,
				readFile: async () => 'model = "grok-4.6"\n',
			};

			let liveStarted = false;
			const service = createAgentService({
				registry: mockRegistry as unknown as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/test' },
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: async (params) => {
					if (params.args.includes('--version')) {
						return { ok: true, exitCode: 0, stdout: 'grok 1.0.13', stderr: '' };
					}
					if (params.args.includes('models') || params.args.includes('--list-models')) {
						liveStarted = true;
						await pendingProbePromise;
						return {
							ok: true,
							exitCode: 0,
							stdout: 'Default model: grok-4.6\nAvailable models:\n  grok-4.6 (default)\n',
							stderr: '',
						};
					}
					return { ok: true, exitCode: 0, stdout: '', stderr: '' };
				},
			});

			await service.start();

			const firstCallPromise = service.listAgentModels('grok');

			for (let i = 0; i < 40 && !liveStarted; i++) {
				await new Promise((r) => setTimeout(r, 5));
			}
			expect(liveStarted).toBe(true);

			const immediateCall = await service.listAgentModels('grok');
			expect(immediateCall.isRefreshing).toBe(true);

			resolveProbe?.(undefined);
			await firstCallPromise;
		});
	});

	describe('6) Arch assertion: service/agents.ts has no forbidden literals (Criterion 9)', () => {
		it('contains zero literals of jsonrpc, model/list, or --list-models in service/agents.ts', () => {
			const servicePath = join(__dirname, '../../src/service/agents.ts');
			const content = readFileSync(servicePath, 'utf8');

			expect(content).not.toContain('jsonrpc');
			expect(content).not.toContain('model/list');
			expect(content).not.toContain('--list-models');
		});
	});
});
