import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readClaudeModels } from '../../src/adapters/claude/read-models.ts';
import { readCodexModels } from '../../src/adapters/codex/read-models.ts';
import { readGrokModels } from '../../src/adapters/grok/read-models.ts';
import { readPiModels } from '../../src/adapters/pi/read-models.ts';
import type {
	PlatformHostInputs,
	ResolveExecutableInput,
	ResolveExecutableResult,
} from '../../src/platform/contract.ts';

async function resolveFakeExecutable(
	input: ResolveExecutableInput,
): Promise<ResolveExecutableResult> {
	const file = input.configuredPath;
	if (!file) {
		return {
			ok: false,
			error: {
				code: 'E_AGENT_EXEC_NOT_FOUND',
				message: 'Missing fake executable path.',
				details: {},
			},
		};
	}
	return {
		ok: true,
		executable: {
			launchKind: 'direct',
			sourcePath: file,
			file,
			argsPrefix: Object.freeze([]),
			checkedPaths: Object.freeze([file]),
		},
	};
}

describe('M4-T5: 四家模型清单读取与降级', () => {
	let testDir: string;
	let hostInputs: PlatformHostInputs;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`agsched-test-models-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		hostInputs = Object.freeze({
			platform: process.platform === 'win32' ? 'win32' : 'linux',
			homedir: testDir,
		});
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe('1) codex TOML／claude JSON／grok TOML／pi models.json 四种格式各自读出清单', () => {
		it('codex: parses models from config.toml and models_cache.json', async () => {
			const configPath = join(testDir, 'config.toml');
			const cachePath = join(testDir, 'models_cache.json');

			writeFileSync(
				configPath,
				`
model = "gpt-6-astra"
model_provider = "OpenAI"

[model_providers.OpenAI]
name = "krill pro"
models = ["gpt-5.6-sol", "gpt-5.6-mini"]
`,
				'utf8',
			);

			writeFileSync(
				cachePath,
				JSON.stringify({
					models: [
						{
							slug: 'gpt-5.3-codex',
							display_name: 'GPT 5.3 Codex',
							description: 'Agentic coding model',
						},
					],
				}),
				'utf8',
			);

			const result = await readCodexModels({ hostInputs, configPath, cachePath });

			expect(result.currentConfigModel).toBe('gpt-6-astra');
			expect(result.isPartial).toBe(false);
			expect(result.configError).toBeUndefined();

			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('gpt-6-astra');
			expect(ids).toContain('gpt-5.6-sol');
			expect(ids).toContain('gpt-5.6-mini');
			expect(ids).toContain('gpt-5.3-codex');

			const defaultModel = result.models.find((m) => m.id === 'gpt-6-astra');
			expect(defaultModel?.isDefault).toBe(true);

			const cachedModel = result.models.find((m) => m.id === 'gpt-5.3-codex');
			expect(cachedModel?.name).toBe('GPT 5.3 Codex');
			expect(cachedModel?.description).toBe('Agentic coding model');
		});

		it('claude: parses models from settings.json and env overrides', async () => {
			const configPath = join(testDir, 'settings.json');

			writeFileSync(
				configPath,
				JSON.stringify({
					model: 'opus[1m]',
					env: {
						ANTHROPIC_MODEL: 'claude-opus-5[1M]',
						ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4.5',
						ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4.5',
					},
				}),
				'utf8',
			);

			const result = await readClaudeModels({ hostInputs, configPath });

			expect(result.currentConfigModel).toBe('opus[1m]');
			expect(result.isPartial).toBe(false);
			expect(result.configError).toBeUndefined();

			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('opus[1m]');
			expect(ids).toContain('claude-opus-5[1M]');
			expect(ids).toContain('claude-haiku-4.5');
			expect(ids).toContain('claude-sonnet-4.5');

			const defaultModel = result.models.find((m) => m.id === 'opus[1m]');
			expect(defaultModel?.isDefault).toBe(true);
		});

		it('grok: parses models from config.toml and command output', async () => {
			const configPath = join(testDir, 'config.toml');

			writeFileSync(
				configPath,
				`
[models]
default = "grok-4.6"

[model."grok-4.6"]
name = "聚蚁"

[ui]
fork_secondary_model = "grok-4.5"
`,
				'utf8',
			);

			const runner = async (spec: { file: string; args: readonly string[] }) => {
				expect(isAbsolute(spec.file)).toBe(true);
				return {
					ok: true,
					stdout: `
Available models:
  * grok-4.6 (default)
  * grok-4.5
  * grok-beta
`,
					stderr: '',
					exitCode: 0,
					timedOut: false,
				};
			};

			const result = await readGrokModels({
				hostInputs,
				configPath,
				executablePath: resolve(testDir, 'fake-grok'),
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
			});

			expect(result.currentConfigModel).toBe('grok-4.6');
			expect(result.isPartial).toBe(false);
			expect(result.configError).toBeUndefined();

			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('grok-4.6');
			expect(ids).toContain('grok-4.5');
			expect(ids).toContain('grok-beta');

			const grok46 = result.models.find((m) => m.id === 'grok-4.6');
			expect(grok46?.isDefault).toBe(true);
			expect(grok46?.name).toBe('聚蚁');
		});

		it('pi: parses models from models.json, models-store.json, and settings.json', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			const storePath = join(testDir, 'models-store.json');

			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: 'gpt-5.6-sol',
				}),
				'utf8',
			);

			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						krillpro: {
							models: [
								{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
								{ id: 'gpt-5.6-mini', name: 'GPT 5.6 Mini' },
							],
						},
					},
				}),
				'utf8',
			);

			writeFileSync(
				storePath,
				JSON.stringify({
					antigravity: {
						models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
					},
				}),
				'utf8',
			);

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				storePath,
				allowCommand: false,
			});

			expect(result.currentConfigModel).toBe('gpt-5.6-sol');
			expect(result.isPartial).toBe(false);
			expect(result.configError).toBeUndefined();

			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('gpt-5.6-sol');
			expect(ids).toContain('gpt-5.6-mini');
			expect(ids).toContain('gemini-3.8-flash');

			const defaultModel = result.models.find((m) => m.id === 'gpt-5.6-sol');
			expect(defaultModel?.isDefault).toBe(true);
		});
	});

	describe('严格识别四家所有已读取配置文件的缺失或损坏', () => {
		it('codex: model = ??? is rejected as invalid TOML and does not become a model', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = ???\n', 'utf8');

			const result = await readCodexModels({ hostInputs, configPath });

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(configPath);
			expect(result.configError?.error).toContain('Invalid TOML value');
			expect(result.models.map((m) => m.id)).not.toContain('???');
		});

		it('grok: model = ??? is rejected as invalid TOML and does not become a model', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = ???\n', 'utf8');

			const result = await readGrokModels({ hostInputs, configPath, allowCommand: false });

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(configPath);
			expect(result.configError?.error).toContain('Invalid TOML value');
			expect(result.models.map((m) => m.id)).not.toContain('???');
		});

		it('pi: settings.json corruption is not swallowed and returns specific absolute path', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			writeFileSync(settingsPath, '{ invalid_settings_json: broken }', 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				allowCommand: false,
			});

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(settingsPath);
			expect(result.configError?.error).toContain('Invalid JSON in settings');
		});

		it('pi: models-store.json corruption is not swallowed and returns specific absolute path', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			const storePath = join(testDir, 'models-store.json');
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');
			writeFileSync(storePath, '{ invalid_store_json: broken }', 'utf8');

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				storePath,
				allowCommand: false,
			});

			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(storePath);
			expect(result.configError?.error).toContain('Invalid JSON in models-store');
		});
	});

	describe('生产超时硬上限固定 5000ms，命令经绝对启动对象执行且超时可终止', () => {
		it('grok: command runner receives absolute launch object, aborts on timeout, and caps timeout at 5000ms', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');

			let receivedFile = '';
			let receivedTimeout = 0;
			let wasAborted = false;

			const runner = async (spec: {
				file: string;
				args: readonly string[];
				timeoutMs: number;
				signal: AbortSignal;
			}) => {
				receivedFile = spec.file;
				receivedTimeout = spec.timeoutMs;
				spec.signal.addEventListener('abort', () => {
					wasAborted = true;
				});

				// Wait for abort signal or complete
				await new Promise((resolve) => {
					if (spec.signal.aborted) resolve(undefined);
					else spec.signal.addEventListener('abort', () => resolve(undefined));
				});

				return {
					ok: false,
					exitCode: null,
					stdout: '',
					stderr: 'Command aborted',
					timedOut: true,
				};
			};

			const fakeExe = resolve(testDir, 'grok-bin');
			const result = await readGrokModels({
				hostInputs,
				configPath,
				executablePath: fakeExe,
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
				timeoutMs: 10, // fast test timeout
				historicalModels: ['grok-history'],
			});

			expect(isAbsolute(receivedFile)).toBe(true);
			expect(receivedFile).toBe(fakeExe);
			expect(receivedTimeout).toBeLessThanOrEqual(5000);
			expect(wasAborted).toBe(true);
			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('timed out'))).toBe(true);
			expect(result.models.map((m) => m.id)).toContain('grok-4.6');
			expect(result.models.map((m) => m.id)).toContain('grok-history');
		});

		it('grok: enforces 5000ms hard ceiling even if options specify a larger timeout', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');

			let recordedTimeout = 0;
			const runner = async (spec: { timeoutMs: number }) => {
				recordedTimeout = spec.timeoutMs;
				return { ok: true, exitCode: 0, stdout: '* grok-4.6\n', stderr: '', timedOut: false };
			};

			await readGrokModels({
				hostInputs,
				configPath,
				executablePath: resolve(testDir, 'fake-grok'),
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
				timeoutMs: 60_000, // caller attempted 60s
			});

			expect(recordedTimeout).toBe(5000);
		});

		it('pi: command runner receives absolute launch object, aborts on timeout, and caps timeout at 5000ms', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');

			let receivedFile = '';
			let wasAborted = false;

			const runner = async (spec: {
				file: string;
				args: readonly string[];
				timeoutMs: number;
				signal: AbortSignal;
			}) => {
				receivedFile = spec.file;
				spec.signal.addEventListener('abort', () => {
					wasAborted = true;
				});

				await new Promise((resolve) => {
					if (spec.signal.aborted) resolve(undefined);
					else spec.signal.addEventListener('abort', () => resolve(undefined));
				});

				return {
					ok: false,
					exitCode: null,
					stdout: '',
					stderr: 'Command aborted',
					timedOut: true,
				};
			};

			const fakePi = resolve(testDir, 'pi-bin');
			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				executablePath: fakePi,
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
				timeoutMs: 10,
				historicalModels: ['claude-3-history'],
			});

			expect(isAbsolute(receivedFile)).toBe(true);
			expect(receivedFile).toBe(fakePi);
			expect(wasAborted).toBe(true);
			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('timed out'))).toBe(true);
			expect(result.models.map((m) => m.id)).toContain('gpt-5.6-sol');
			expect(result.models.map((m) => m.id)).toContain('claude-3-history');
		});

		it('pi: enforces 5000ms hard ceiling even if options specify a larger timeout', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');

			let recordedTimeout = 0;
			const runner = async (spec: { timeoutMs: number }) => {
				recordedTimeout = spec.timeoutMs;
				return { ok: true, exitCode: 0, stdout: '* gpt-5.6-sol\n', stderr: '', timedOut: false };
			};

			await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				executablePath: resolve(testDir, 'fake-pi'),
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
				timeoutMs: 30_000,
			});

			expect(recordedTimeout).toBe(5000);
		});

		it('grok: resolves an absolute Windows batch target into a complete ComSpec launch', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');
			let receivedSpec:
				| {
						readonly file: string;
						readonly args: readonly string[];
						readonly windowsVerbatimArguments?: true;
				  }
				| undefined;
			const commandRunner = async (spec: {
				file: string;
				args: readonly string[];
				windowsVerbatimArguments?: true;
			}) => {
				receivedSpec = spec;
				return { ok: true, exitCode: 0, stdout: '* grok-4.6\n', stderr: '', timedOut: false };
			};
			const scriptPath = 'C:\\Tools\\grok.cmd';
			const commandProcessor = 'C:\\Windows\\System32\\cmd.exe';
			const resolveExecutable = async (): Promise<ResolveExecutableResult> => ({
				ok: true,
				executable: {
					launchKind: 'com-spec',
					sourcePath: scriptPath,
					file: commandProcessor,
					argsPrefix: Object.freeze([]),
					checkedPaths: Object.freeze([scriptPath, commandProcessor]),
					spawnOptions: Object.freeze({ windowsVerbatimArguments: true }),
				},
			});

			await readGrokModels({
				hostInputs: { platform: 'win32', homedir: 'C:\\Users\\test' },
				configPath,
				executablePath: scriptPath,
				resolveExecutable,
				commandRunner,
			});

			expect(receivedSpec?.file).toBe(commandProcessor);
			expect(receivedSpec?.windowsVerbatimArguments).toBe(true);
			expect(receivedSpec?.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
			expect(receivedSpec?.args[3]).toContain('grok.cmd');
			expect(receivedSpec?.args[3]).toContain('models');
		});
	});

	describe('可替换异步文件系统能力与宿主快照', () => {
		it('works with a pure in-memory mock ModelReaderFileSystem without touching disk', async () => {
			const inMemoryStore: Record<string, string> = {
				[resolve('/virtual/home/.codex/config.toml')]: 'model = "virtual-gpt-6"\n',
				[resolve('/virtual/home/.claude/settings.json')]: JSON.stringify({
					model: 'virtual-claude',
				}),
			};

			const mockFs = {
				readFile: async (path: string) => {
					const content = inMemoryStore[path];
					if (content === undefined) {
						const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
						err.code = 'ENOENT';
						throw err;
					}
					return content;
				},
				stat: async (path: string) => {
					if (inMemoryStore[path] === undefined) {
						const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
						err.code = 'ENOENT';
						throw err;
					}
					return { mtimeMs: 123456789 };
				},
			};

			const mockHostInputs: PlatformHostInputs = {
				platform: 'linux',
				homedir: '/virtual/home',
			};

			const codexResult = await readCodexModels({ hostInputs: mockHostInputs, fs: mockFs });
			expect(codexResult.currentConfigModel).toBe('virtual-gpt-6');
			expect(codexResult.mtimeMs).toBe(123456789);

			const claudeResult = await readClaudeModels({ hostInputs: mockHostInputs, fs: mockFs });
			expect(claudeResult.currentConfigModel).toBe('virtual-claude');
			expect(claudeResult.mtimeMs).toBe(123456789);
		});
	});

	describe('Pi 的 {providers:{}} 或空 models 是合法空目录并继续合并其他来源', () => {
		it('treats {providers:{}} as valid empty catalog without parser failure and merges store/history/cache', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			const storePath = join(testDir, 'models-store.json');

			// Current real machine shape
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');
			writeFileSync(
				storePath,
				JSON.stringify({
					antigravity: {
						models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Antigravity)' }],
					},
				}),
				'utf8',
			);

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				storePath,
				allowCommand: false,
				historicalModels: ['gpt-5.0-history'],
				cachedModels: [{ id: 'cached-model-1' }],
			});

			expect(result.isPartial).toBe(false);
			expect(result.warnings).toEqual([]);
			expect(result.currentConfigModel).toBe('gpt-5.6-sol');

			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('gpt-5.6-sol');
			expect(ids).toContain('gemini-3.8-flash');
			expect(ids).toContain('gpt-5.0-history');
			expect(ids).toContain('cached-model-1');
		});

		it('treats top-level models: [] and empty array [] as valid empty catalogs', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');

			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ models: [] }), 'utf8');

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				allowCommand: false,
			});

			expect(result.isPartial).toBe(false);
			expect(result.warnings).toEqual([]);
			expect(result.currentConfigModel).toBe('gpt-5.6-sol');
		});

		it('marks parser failure only on truly unrecognized non-empty schema structures (E-90)', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');

			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ v3_unknown_structure: { dummy: 123 } }), 'utf8');

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				allowCommand: false,
				cachedModels: [{ id: 'cached-fallback' }],
			});

			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('structure may have changed'))).toBe(true);
			expect(result.models.map((m) => m.id)).toContain('cached-fallback');
		});
	});

	describe('3) 输出格式变化解析不了时同样降级，且原始 stdout 保留在可展开日志里不静默吞掉（E-39）', () => {
		it('grok: unparseable output format retains rawStdout and sets isPartial', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');

			const unparseable = 'V3_SYS_STREAM: arbitrary unrecognized tokens';
			const runner = async () => ({
				ok: true,
				exitCode: 0,
				stdout: unparseable,
				stderr: '',
				timedOut: false,
			});

			const result = await readGrokModels({
				hostInputs,
				configPath,
				executablePath: resolve(testDir, 'fake-grok'),
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
			});

			expect(result.isPartial).toBe(true);
			expect(result.rawStdout).toBe(unparseable);
			expect(result.warnings.some((w) => w.includes('format may have changed'))).toBe(true);
		});

		it('pi: unparseable output format retains rawStdout and sets isPartial', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');

			const unparseable = 'RANDOM_PI_LOGS: not a list of models';
			const runner = async () => ({
				ok: true,
				exitCode: 0,
				stdout: unparseable,
				stderr: '',
				timedOut: false,
			});

			const result = await readPiModels({
				hostInputs,
				settingsPath,
				modelsPath,
				executablePath: resolve(testDir, 'fake-pi'),
				resolveExecutable: resolveFakeExecutable,
				commandRunner: runner,
			});

			expect(result.isPartial).toBe(true);
			expect(result.rawStdout).toBe(unparseable);
			expect(result.warnings.some((w) => w.includes('format may have changed'))).toBe(true);
		});
	});

	describe('5) 每次打开设置页按文件 mtime 重读，不长期缓存（E-44）', () => {
		it('detects external file modification and re-reads new values by mtime', async () => {
			const configPath = join(testDir, 'config.toml');

			writeFileSync(configPath, 'model = "gpt-5.6-sol"\n', 'utf8');
			const firstRead = await readCodexModels({ hostInputs, configPath });
			expect(firstRead.currentConfigModel).toBe('gpt-5.6-sol');
			const firstMtime = firstRead.mtimeMs;
			expect(firstMtime).toBeDefined();

			// External update to file
			writeFileSync(configPath, 'model = "gpt-6-astra"\n', 'utf8');
			const secondRead = await readCodexModels({ hostInputs, configPath });
			expect(secondRead.currentConfigModel).toBe('gpt-6-astra');
		});
	});

	describe('E-45: 别名与完整 ID 并存时都原样透传，不做别名映射、不做去重合并', () => {
		it('claude: keeps both opus alias and full model ID as distinct choices', async () => {
			const configPath = join(testDir, 'settings.json');

			writeFileSync(
				configPath,
				JSON.stringify({
					model: 'opus',
					env: {
						ANTHROPIC_MODEL: 'claude-opus-5[1M]',
					},
					models: ['sonnet', 'claude-sonnet-4.5'],
				}),
				'utf8',
			);

			const result = await readClaudeModels({ hostInputs, configPath });
			const ids = result.models.map((m) => m.id);

			expect(ids).toContain('opus');
			expect(ids).toContain('claude-opus-5[1M]');
			expect(ids).toContain('sonnet');
			expect(ids).toContain('claude-sonnet-4.5');
			expect(ids.length).toBe(4);
		});
	});
});
