import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readClaudeModels } from '../../src/adapters/claude/read-models.ts';
import { readCodexModels } from '../../src/adapters/codex/read-models.ts';
import { readGrokModels } from '../../src/adapters/grok/read-models.ts';
import { readPiModels } from '../../src/adapters/pi/read-models.ts';

describe('M4-T5: 四家模型清单读取与降级', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`agsched-test-models-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
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

			const result = await readCodexModels({ configPath, cachePath });

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

			const result = await readClaudeModels({ configPath });

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

			const runner = async () => ({
				stdout: `
Available models:
  * grok-4.6 (default)
  * grok-4.5
  * grok-beta
`,
				stderr: '',
				exitCode: 0,
			});

			const result = await readGrokModels({ configPath, commandRunner: runner });

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

	describe('2) 列模型命令超 5 秒或退出码非 0 时降级为「配置文件当前值 + 历史用过 + 手填」并标「清单可能不全」，绝不阻塞派发（E-38）', () => {
		it('grok models: non-zero exit code downgrades gracefully with isPartial=true', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');

			const runner = async () => ({
				stdout: '',
				stderr: 'Error: Connection failed',
				exitCode: 1,
			});

			const result = await readGrokModels({
				configPath,
				commandRunner: runner,
				historicalModels: ['grok-4.0-historical'],
			});

			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('non-zero status'))).toBe(true);
			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('grok-4.6');
			expect(ids).toContain('grok-4.0-historical');
		});

		it('grok models: command timeout (> 5000ms) downgrades gracefully with isPartial=true', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');

			const runner = async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { stdout: '', stderr: '', exitCode: 0 };
			};

			const result = await readGrokModels({
				configPath,
				commandRunner: runner,
				timeoutMs: 20, // test with short timeout threshold
				historicalModels: ['grok-historic'],
			});

			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('timed out'))).toBe(true);
			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('grok-4.6');
			expect(ids).toContain('grok-historic');
		});

		it('pi --models: non-zero exit code downgrades gracefully without throwing', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');
			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			writeFileSync(modelsPath, JSON.stringify({ models: [{ id: 'gpt-5.6-sol' }] }), 'utf8');

			const runner = async () => ({
				stdout: '',
				stderr: 'Error: Unknown option: --models',
				exitCode: 1,
			});

			const result = await readPiModels({
				settingsPath,
				modelsPath,
				commandRunner: runner,
				historicalModels: ['claude-3-historical'],
			});

			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('non-zero status'))).toBe(true);
			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('gpt-5.6-sol');
			expect(ids).toContain('claude-3-historical');
		});
	});

	describe('3) 输出格式变化解析不了时同样降级，且原始 stdout 保留在可展开日志里不静默吞掉（E-39、E-90）', () => {
		it('E-39: grok models output format changed -> retains rawStdout and sets isPartial', async () => {
			const configPath = join(testDir, 'config.toml');
			writeFileSync(configPath, 'model = "grok-4.6"\n', 'utf8');

			const unparseableOutput =
				'V3_ENGINE_INITIALIZED: {"status": "ok", "arbitrary_data": [1, 2, 3]}';
			const runner = async () => ({
				stdout: unparseableOutput,
				stderr: '',
				exitCode: 0,
			});

			const result = await readGrokModels({
				configPath,
				commandRunner: runner,
				historicalModels: ['grok-4.5'],
			});

			expect(result.isPartial).toBe(true);
			expect(result.rawStdout).toBe(unparseableOutput);
			expect(result.warnings.some((w) => w.includes('format may have changed'))).toBe(true);
			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('grok-4.6');
			expect(ids).toContain('grok-4.5');
		});

		it('E-90: pi models.json structure changed -> preserves cachedModels and marks isPartial', async () => {
			const settingsPath = join(testDir, 'settings.json');
			const modelsPath = join(testDir, 'models.json');

			writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-5.6-sol' }), 'utf8');
			// Corrupted/unrecognized schema in models.json
			writeFileSync(modelsPath, JSON.stringify({ v3_unknown_structure: { dummy: 123 } }), 'utf8');

			const result = await readPiModels({
				settingsPath,
				modelsPath,
				allowCommand: false,
				cachedModels: [
					{ id: 'gpt-5.6-cached-1', name: 'Cached 1' },
					{ id: 'gpt-5.6-cached-2', name: 'Cached 2' },
				],
				historicalModels: ['gpt-5.0-history'],
			});

			expect(result.isPartial).toBe(true);
			expect(result.warnings.some((w) => w.includes('structure may have changed'))).toBe(true);

			const ids = result.models.map((m) => m.id);
			expect(ids).toContain('gpt-5.6-sol');
			expect(ids).toContain('gpt-5.6-cached-1');
			expect(ids).toContain('gpt-5.6-cached-2');
			expect(ids).toContain('gpt-5.0-history');
		});
	});

	describe('4) 配置文件缺失或语法损坏时视为「无配置值」不崩溃，提示解析失败并给出文件绝对路径（E-43）', () => {
		it('codex: missing config file returns configError with absolute path without throwing', async () => {
			const missingPath = join(testDir, 'non-existent.toml');
			const result = await readCodexModels({ configPath: missingPath });

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(missingPath);
			expect(result.configError?.error).toContain('does not exist');
		});

		it('codex: corrupted TOML returns configError with path and syntax error without crashing', async () => {
			const badPath = join(testDir, 'bad-config.toml');
			writeFileSync(badPath, 'model = "unclosed string\n[broken table', 'utf8');

			const result = await readCodexModels({ configPath: badPath });

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(badPath);
			expect(result.configError?.error).toBeDefined();
		});

		it('claude: corrupted JSON returns configError with path and syntax error without crashing', async () => {
			const badPath = join(testDir, 'bad-settings.json');
			writeFileSync(badPath, '{ "model": "broken", invalid_json }', 'utf8');

			const result = await readClaudeModels({ configPath: badPath });

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(badPath);
		});

		it('grok: missing config file returns configError with path without crashing', async () => {
			const missingPath = join(testDir, 'no-grok.toml');
			const result = await readGrokModels({ configPath: missingPath, allowCommand: false });

			expect(result.currentConfigModel).toBeNull();
			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(missingPath);
		});

		it('pi: missing models.json returns configError with path without crashing', async () => {
			const missingPath = join(testDir, 'no-models.json');
			const result = await readPiModels({ modelsPath: missingPath, allowCommand: false });

			expect(result.configError).toBeDefined();
			expect(result.configError?.path).toBe(missingPath);
		});
	});

	describe('5) 每次打开设置页按文件 mtime 重读，不长期缓存（E-44）', () => {
		it('detects external file modification and re-reads new values by mtime', async () => {
			const configPath = join(testDir, 'config.toml');

			writeFileSync(configPath, 'model = "gpt-5.6-sol"\n', 'utf8');
			const firstRead = await readCodexModels({ configPath });
			expect(firstRead.currentConfigModel).toBe('gpt-5.6-sol');
			const firstMtime = firstRead.mtimeMs;
			expect(firstMtime).toBeDefined();

			// External update to file
			writeFileSync(configPath, 'model = "gpt-6-astra"\n', 'utf8');
			const secondRead = await readCodexModels({ configPath });
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

			const result = await readClaudeModels({ configPath });
			const ids = result.models.map((m) => m.id);

			expect(ids).toContain('opus');
			expect(ids).toContain('claude-opus-5[1M]');
			expect(ids).toContain('sonnet');
			expect(ids).toContain('claude-sonnet-4.5');

			// Neither alias was stripped or converted
			expect(ids.length).toBe(4);
		});
	});
});
