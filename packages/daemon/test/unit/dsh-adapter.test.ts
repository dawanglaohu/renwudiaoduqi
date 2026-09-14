import { type Stats, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import {
	DEFAULT_DSH_BIN_PATH,
	buildDshLaunchSpec,
	buildLaunchSpec,
} from '../../src/adapters/dsh/build-launch-spec.ts';
import {
	DSH_CAPABILITIES,
	capabilities,
	getCapabilities,
	getDshCapabilities,
} from '../../src/adapters/dsh/capabilities.ts';
import {
	DSH_VENDOR_EVENT_STRINGS,
	isKnownDshEventType,
	mapDshEvents,
	parseAndMapDshLine,
} from '../../src/adapters/dsh/map-events.ts';
import { readDshModels, readModels } from '../../src/adapters/dsh/read-models.ts';
import { type DshSmokeRunnerParams, runDshSmokeTest } from '../../src/adapters/dsh/smoke.ts';
import { probeAgent } from '../../src/adapters/probe.ts';
import { BUILT_IN_AGENT_DEFAULTS, BUILT_IN_AGENT_IDS } from '../../src/config/defaults.ts';
import type { AgentRegistry, AgentRegistrySnapshot } from '../../src/config/registry.ts';
import { PERMISSION_TIERS } from '../../src/domain/permission-tier.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import type { ExecutableFileSystem, PlatformHostInputs } from '../../src/platform/contract.ts';
import { createAgentService } from '../../src/service/agents.ts';
import type { LogstoreService } from '../../src/service/logstore.ts';
import { createRunService } from '../../src/service/run.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const daemonSrc = resolve(__dirname, '../../src');

function collectTypeScriptFiles(dirPath: string): string[] {
	const results: string[] = [];
	const entries = readdirSync(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTypeScriptFiles(fullPath));
		} else if (entry.isFile() && extname(entry.name) === '.ts') {
			results.push(fullPath);
		}
	}
	return results;
}

describe('M4-T12: dsh headless 适配器与通用 ACP 扩展槽', () => {
	describe('AC 1 & E-193: dsh 走 --profile headless 接入与 CLI 入口解析', () => {
		it('builds launch spec with --profile headless and places prompt as final argument', () => {
			const spec = buildDshLaunchSpec({
				runId: 'dsh-run-1',
				cwd: '/workspace/project',
				prompt: 'echo "implement feature"',
			});

			expect(spec.cwd).toBe('/workspace/project');
			expect(spec.args).toContain('--profile');
			const profileIdx = spec.args.indexOf('--profile');
			expect(spec.args[profileIdx + 1]).toBe('headless');
			expect(spec.args[spec.args.length - 1]).toBe('echo "implement feature"');
			expect(Object.isFrozen(spec)).toBe(true);
			expect(Object.isFrozen(spec.args)).toBe(true);
		});

		it('defaults to application internal bin.js executed via node when execPath not given (E-193)', () => {
			const spec = buildLaunchSpec({
				runId: 'dsh-run-internal',
				cwd: '/workspace/project',
			});

			expect(spec.file).toBe(process.execPath);
			expect(spec.args[0]).toBe(DEFAULT_DSH_BIN_PATH);
			expect(spec.args).toContain('--profile');
			expect(spec.args[spec.args.indexOf('--profile') + 1]).toBe('headless');
		});

		it('supports user hand-entered custom absolute binary or bin.js path (E-193)', () => {
			const customBinarySpec = buildDshLaunchSpec({
				runId: 'dsh-custom-bin',
				cwd: '/workspace/project',
				execPath: '/opt/deepseek/bin/dsh',
				prompt: 'run task',
			});
			expect(customBinarySpec.file).toBe('/opt/deepseek/bin/dsh');
			expect(customBinarySpec.args[0]).toBe('--profile');
			expect(customBinarySpec.args[1]).toBe('headless');

			const customJsSpec = buildDshLaunchSpec({
				runId: 'dsh-custom-js',
				cwd: '/workspace/project',
				execPath: '/opt/custom/dsh/bin.js',
				prompt: 'run task',
			});
			expect(customJsSpec.file).toBe(process.execPath);
			expect(customJsSpec.args[0]).toBe('/opt/custom/dsh/bin.js');
			expect(customJsSpec.args).toContain('--profile');
		});

		it('maps three permission tiers to DSH_PERMISSION_MODE env overrides', () => {
			const tiers = [
				{ tier: PERMISSION_TIERS.READ_ONLY, expected: 'read-only' },
				{ tier: PERMISSION_TIERS.WORKSPACE_WRITE, expected: 'workspace-write' },
				{ tier: PERMISSION_TIERS.UNRESTRICTED, expected: 'danger-full-access' },
			] as const;

			for (const { tier, expected } of tiers) {
				const spec = buildDshLaunchSpec({
					runId: 'dsh-perm-run',
					cwd: '/workspace/project',
					permissionTier: tier,
				});

				expect(spec.envOverrides?.DSH_PERMISSION_MODE).toBe(expected);
			}
		});

		it('passes model parameter if specified', () => {
			const spec = buildDshLaunchSpec({
				runId: 'dsh-model-run',
				cwd: '/workspace/project',
				model: 'deepseek-reasoner',
				prompt: 'solve problem',
			});

			expect(spec.args).toContain('--model');
			expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('deepseek-reasoner');
		});
	});

	describe('AC 2 & E-253 & R2: 能力位 hasStreamingEvents 置假与事件映射收流契约', () => {
		it('strictly sets hasStreamingEvents=false, sessionHistory=current-run-only, and outputMode=plain-text-final', () => {
			expect(DSH_CAPABILITIES.hasStreamingEvents).toBe(false);
			expect(capabilities.hasStreamingEvents).toBe(false);
			expect(getDshCapabilities().hasStreamingEvents).toBe(false);
			expect(getCapabilities().hasStreamingEvents).toBe(false);

			expect(DSH_CAPABILITIES.canReply).toBe(false);
			expect(DSH_CAPABILITIES.canResume).toBe(false);
			expect(DSH_CAPABILITIES.supportsReasoningEffort).toBe(false);
			expect(DSH_CAPABILITIES.sessionHistory).toBe('current-run-only');
			expect(DSH_CAPABILITIES.outputMode).toBe('plain-text-final'); // R2 (c)
			expect(DSH_CAPABILITIES.mode).toBe('headless');
			expect(Object.isFrozen(DSH_CAPABILITIES)).toBe(true);
		});

		it('R2 (a): correctly handles object inputs without String(obj) -> [object Object]', () => {
			// Object with text field
			const objWithText = { text: 'Assistant final conclusion.' };
			const events1 = mapDshEvents(objWithText);
			expect(events1.length).toBe(1);
			expect(events1[0]?.payload.chunk).toBe('Assistant final conclusion.');
			expect(events1[0]?.payload.chunk).not.toContain('[object Object]');
			expect(events1[0]?.payload.vendor).toEqual(objWithText);

			// Object without discriminant or text fields
			const emptyObj = { foo: 'bar', timestamp: 12345 };
			const result = parseAndMapDshLine(emptyObj);
			expect(result.events).toEqual([]);
			expect(result.unmappedCount).toBe(1); // R2 (d)
		});

		it('R2 (b): filters out dsh banners and progress lines; only terminal assistant text emits event', () => {
			const bannerLines = [
				'DeepSeek Harness v0.1.0 (headless)',
				'Loading profile headless...',
				'[info] Initializing workspace...',
				'[progress] Executing model...',
				'==============================',
				'------------------------------',
			];

			for (const banner of bannerLines) {
				const events = mapDshEvents(banner);
				expect(events).toEqual([]);
			}

			// Actual terminal assistant text emits exactly 1 event
			const assistantText = 'Here is the completed implementation.';
			const events = mapDshEvents(assistantText);
			expect(events.length).toBe(1);
			expect(events[0]?.payload.chunk).toBe(assistantText);
		});

		it('R2 (e): preserves multi-line text with original newlines verbatim and attaches vendor payload', () => {
			const multiLineText = 'Line 1: Summary\nLine 2: Details\nLine 3: Done.';
			const events = mapDshEvents(multiLineText, { runId: 'run-multi' });

			expect(events.length).toBe(1);
			expect(events[0]?.payload.chunk).toBe(multiLineText);
			expect(events[0]?.payload.content).toBe(multiLineText);
			expect(events[0]?.payload.vendor).toBe(multiLineText);
			expect(events[0]?.runId).toBe('run-multi');
		});

		it('R2 (c) & E-140: runService.ingestLine with acceptsPlainText=true passes plain text to mapper without unmapped_event_count', async () => {
			const mockLogstore = {
				appendRaw: vi.fn(async () => ({ offset: 0, byteLen: 50 })),
				appendEvent: vi.fn(async () => ({ offset: 0, byteLen: 100, seq: 1 })),
			};
			const mockRunsRepo = {
				findById: vi.fn(() => null),
				updateState: vi.fn(),
				updateLastEventAt: vi.fn(),
				incrementUnmappedEventCount: vi.fn(),
				findInFlight: vi.fn(() => []),
			};

			const mockEnvelopeFactory = {
				createEnvelope: vi.fn(
					(input: import('../../src/adapters/dsh/map-events.ts').EventEnvelopeInput) => ({
						...input,
						id: 1,
						ts: new Date().toISOString(),
						seq: 1,
					}),
				),
			};
			const runService = createRunService({
				logstore: mockLogstore as unknown as LogstoreService,
				clock: { now: () => new Date().toISOString() },
				envelopeFactory: mockEnvelopeFactory as unknown as EnvelopeFactory,
				runsRepo: mockRunsRepo,
				eventMapper: (line: unknown) => {
					const inputs = mapDshEvents(line, { runId: 'run-plain-1' });
					return inputs.map(
						(inp) => mockEnvelopeFactory.createEnvelope(inp) as unknown as EventEnvelope,
					);
				},
			});

			const plainTextOutput = 'Final analysis finished successfully.';
			const result = await runService.ingestLine('run-plain-1', plainTextOutput, {
				acceptsPlainText: true,
			});

			expect(result.rawAppended).toBe(true);
			expect(result.eventsAppended).toBe(1);
			expect(result.unmappedDiscarded).toBe(false); // E-140: not discarded as unmapped
			expect(mockRunsRepo.incrementUnmappedEventCount).not.toHaveBeenCalled();
		});
	});

	describe('AC 3 & E-191 & E-28 & R3: 启用前过探测 + 冒烟任务（生产接线与单测覆盖）', () => {
		it('passes standalone runDshSmokeTest on contract match', async () => {
			const mockRunner = vi.fn(async (_params: DshSmokeRunnerParams) => ({
				ok: true,
				exitCode: 0,
				stdout: 'OK\n',
				stderr: '',
			}));

			const result = await runDshSmokeTest({
				runner: mockRunner,
				smokePrompt: 'ping',
			});

			expect(result.ok).toBe(true);
			expect(result.stdout).toBe('OK');
			expect(result.exitCode).toBe(0);
			expect(result.reason).toBeUndefined();
			expect(mockRunner).toHaveBeenCalledTimes(1);

			const callArgs = mockRunner.mock.calls[0]?.[0];
			expect(callArgs?.args).toContain('--profile');
			expect(callArgs?.args[callArgs.args.indexOf('--profile') + 1]).toBe('headless');
			expect(callArgs?.args).toContain('ping');
		});

		it('R3 case 1 (E-191): non-zero exit code makes dsh unavailable with failure reason in DTO, others unaffected', async () => {
			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						dsh: {
							...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
							execPath: '/usr/bin/dsh',
							isEnabled: true,
						},
						codex: {
							...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.CODEX],
							execPath: '/usr/bin/codex',
							isEnabled: true,
						},
					},
					builtInDefaults: Object.freeze({}),
					storedDefaults: Object.freeze({}),
					userOverrides: {},
					defaultUpdates: [],
				}),
				start: vi.fn(async () => ({}) as unknown as AgentRegistrySnapshot),
				stop: vi.fn(),
			};

			const mockFs = {
				lstat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					}) as unknown as Stats,
				readlink: async (p: string) => p,
				realpath: async (p: string) => p,
				stat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						mtimeMs: 1000,
						size: 5000,
					}) as unknown as Stats,
				access: async () => undefined,
			};

			// Runner: probe (--version) succeeds, but smoke test exits with code 1
			const mockRunner = vi.fn(async (params: { file: string; args: readonly string[] }) => {
				if (params.file.includes('codex')) {
					return { ok: true, exitCode: 0, stdout: 'codex 1.0.0', stderr: '' };
				}
				if (params.args.includes('--version')) {
					return { ok: true, exitCode: 0, stdout: 'dsh 0.1.1', stderr: '' };
				}
				// Smoke run
				return { ok: false, exitCode: 1, stdout: '', stderr: 'Fatal: invalid profile' };
			});

			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/tester' },
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: mockRunner,
			});

			const dshDto = await service.getAgent('dsh');
			expect(dshDto?.isAvailable).toBe(false);
			expect(dshDto?.unavailableReason).toContain('non-zero exit code: 1');

			// Assert other agents (codex) are completely unaffected
			const codexDto = await service.getAgent('codex');
			expect(codexDto?.isAvailable).toBe(true);
		});

		it('R3 case 2 (E-191): non-empty stderr makes dsh unavailable with failure reason in DTO', async () => {
			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						dsh: {
							...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
							execPath: '/usr/bin/dsh',
							isEnabled: true,
						},
					},
					builtInDefaults: Object.freeze({}),
					storedDefaults: Object.freeze({}),
					userOverrides: {},
					defaultUpdates: [],
				}),
				start: vi.fn(async () => ({}) as unknown as AgentRegistrySnapshot),
				stop: vi.fn(),
			};

			const mockFs = {
				lstat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					}) as unknown as Stats,
				readlink: async (p: string) => p,
				realpath: async (p: string) => p,
				stat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						mtimeMs: 1000,
						size: 5000,
					}) as unknown as Stats,
				access: async () => undefined,
			};

			const mockRunner = vi.fn(async (params: { args: readonly string[] }) => {
				if (params.args.includes('--version')) {
					return { ok: true, exitCode: 0, stdout: 'dsh 0.1.1', stderr: '' };
				}
				// Smoke run: exit code 0 but non-empty stderr
				return { ok: true, exitCode: 0, stdout: 'OK', stderr: 'Warning: unexpected runtime log' };
			});

			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/tester' },
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: mockRunner,
			});

			const dshDto = await service.getAgent('dsh');
			expect(dshDto?.isAvailable).toBe(false);
			expect(dshDto?.unavailableReason).toContain('expected empty stderr on success');
		});

		it('R3 case 3 (E-191): empty stdout makes dsh unavailable with failure reason in DTO', async () => {
			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						dsh: {
							...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
							execPath: '/usr/bin/dsh',
							isEnabled: true,
						},
					},
					builtInDefaults: Object.freeze({}),
					storedDefaults: Object.freeze({}),
					userOverrides: {},
					defaultUpdates: [],
				}),
				start: vi.fn(async () => ({}) as unknown as AgentRegistrySnapshot),
				stop: vi.fn(),
			};

			const mockFs = {
				lstat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					}) as unknown as Stats,
				readlink: async (p: string) => p,
				realpath: async (p: string) => p,
				stat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						mtimeMs: 1000,
						size: 5000,
					}) as unknown as Stats,
				access: async () => undefined,
			};

			const mockRunner = vi.fn(async (params: { args: readonly string[] }) => {
				if (params.args.includes('--version')) {
					return { ok: true, exitCode: 0, stdout: 'dsh 0.1.1', stderr: '' };
				}
				// Smoke run: exit code 0 and empty stderr, but empty stdout
				return { ok: true, exitCode: 0, stdout: '   \n', stderr: '' };
			});

			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/tester' },
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: mockRunner,
			});

			const dshDto = await service.getAgent('dsh');
			expect(dshDto?.isAvailable).toBe(false);
			expect(dshDto?.unavailableReason).toContain('expected terminal assistant text on stdout');
		});

		it('R3 case 4: smoke test completely passes -> dsh is available and canDispatch=true', async () => {
			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						dsh: {
							...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
							execPath: '/usr/bin/dsh',
							isEnabled: true,
						},
					},
					builtInDefaults: Object.freeze({}),
					storedDefaults: Object.freeze({}),
					userOverrides: {},
					defaultUpdates: [],
				}),
				start: vi.fn(async () => ({}) as unknown as AgentRegistrySnapshot),
				stop: vi.fn(),
			};

			const mockFs = {
				lstat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					}) as unknown as Stats,
				readlink: async (p: string) => p,
				realpath: async (p: string) => p,
				stat: async () =>
					({
						isFile: () => true,
						isDirectory: () => false,
						mtimeMs: 1000,
						size: 5000,
					}) as unknown as Stats,
				access: async () => undefined,
			};

			const mockRunner = vi.fn(async (params: { args: readonly string[] }) => {
				if (params.args.includes('--version')) {
					return { ok: true, exitCode: 0, stdout: 'dsh 0.1.1', stderr: '' };
				}
				return { ok: true, exitCode: 0, stdout: 'All tests passed cleanly.', stderr: '' };
			});

			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/tester' },
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: mockRunner,
			});

			const dshDto = await service.getAgent('dsh');
			expect(dshDto?.isAvailable).toBe(true);
			await expect(service.assertCanDispatch('dsh')).resolves.toBeUndefined();
		});
	});

	describe('AC 5 & E-194 & R4 & R6: 版本超出注册表已知区间时允许启用但常驻提示「Unverified agent version」', () => {
		it('R4: version within registry versionRange produces no warning banner', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'dsh 0.1.1',
				stderr: '',
			}));

			const linuxHost: PlatformHostInputs = {
				platform: 'linux',
				homedir: '/home/tester',
			};

			const mockFs = {
				lstat: vi.fn(
					async () =>
						({
							isFile: () => true,
							isDirectory: () => false,
							isSymbolicLink: () => false,
						}) as unknown as Stats,
				),
				readlink: vi.fn(async () => '/usr/bin/dsh'),
				realpath: vi.fn(async () => '/usr/bin/dsh'),
				stat: vi.fn(
					async () =>
						({
							isFile: () => true,
							isDirectory: () => false,
							mtimeMs: 1000,
							size: 5000,
						}) as unknown as Stats,
				),
				access: vi.fn(async () => undefined),
			};

			const dshConfig = {
				...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
				execPath: '/usr/bin/dsh',
			};

			const result = await probeAgent({
				agentId: 'dsh',
				config: dshConfig,
				hostInputs: linuxHost,
				fileSystem: mockFs,
				commandRunner: mockRunner,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('matched');
			expect(result.canDispatch).toBe(true);
			expect(result.warningBanner).toBeUndefined(); // In range: no banner
		});

		it('R4 & R6: version outside registry versionRange has canDispatch=true and attaches warningBanner to DTO', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'dsh 0.3.0',
				stderr: '',
			}));

			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						dsh: {
							...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
							execPath: '/usr/bin/dsh',
							isEnabled: true,
						},
					},
					builtInDefaults: Object.freeze({}),
					storedDefaults: Object.freeze({}),
					userOverrides: {},
					defaultUpdates: [],
				}),
				start: vi.fn(async () => ({}) as unknown as AgentRegistrySnapshot),
				stop: vi.fn(),
			};

			const mockFs = {
				lstat: vi.fn(
					async () =>
						({
							isFile: () => true,
							isDirectory: () => false,
							isSymbolicLink: () => false,
						}) as unknown as Stats,
				),
				readlink: vi.fn(async () => '/usr/bin/dsh'),
				realpath: vi.fn(async () => '/usr/bin/dsh'),
				stat: vi.fn(
					async () =>
						({
							isFile: () => true,
							isDirectory: () => false,
							mtimeMs: 1000,
							size: 5000,
						}) as unknown as Stats,
				),
				access: vi.fn(async () => undefined),
			};

			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs: { platform: 'linux', homedir: '/home/tester' },
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: mockRunner,
			});

			const dshDto = await service.getAgent('dsh');
			expect(dshDto?.isAvailable).toBe(true); // E-194: 允许启用
			expect(dshDto?.warningBanner).toBeDefined();
			expect(dshDto?.warningBanner?.code).toBe('E_AGENT_VERSION_UNRECOGNIZED');
			expect(dshDto?.warningBanner?.message).toBe('Unverified agent version'); // R6: English short sentence
		});

		it('R4: completely unrecognizable version output remains unavailable', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'unknown-tool 9.9.9',
				stderr: '',
			}));

			const linuxHost: PlatformHostInputs = {
				platform: 'linux',
				homedir: '/home/tester',
			};

			const mockFs = {
				lstat: vi.fn(
					async () =>
						({
							isFile: () => true,
							isDirectory: () => false,
							isSymbolicLink: () => false,
						}) as unknown as Stats,
				),
				readlink: vi.fn(async () => '/usr/bin/dsh'),
				realpath: vi.fn(async () => '/usr/bin/dsh'),
				stat: vi.fn(
					async () =>
						({
							isFile: () => true,
							isDirectory: () => false,
							mtimeMs: 1000,
							size: 5000,
						}) as unknown as Stats,
				),
				access: vi.fn(async () => undefined),
			};

			const dshConfig = {
				...BUILT_IN_AGENT_DEFAULTS[BUILT_IN_AGENT_IDS.DSH],
				execPath: '/usr/bin/dsh',
			};

			const result = await probeAgent({
				agentId: 'dsh',
				config: dshConfig,
				hostInputs: linuxHost,
				fileSystem: mockFs,
				commandRunner: mockRunner,
				isCustomPath: false,
			});

			expect(result.ok).toBe(false);
			expect(result.canDispatch).toBe(false); // Completely unrecognized -> cannot dispatch
			expect(result.status).toBe('unrecognized');
		});
	});

	describe('AC 6 & E-188: 会话回读标「仅本次运行」', () => {
		it('marks sessionHistory as current-run-only (E-188)', () => {
			expect(DSH_CAPABILITIES.sessionHistory).toBe('current-run-only');
			expect(getDshCapabilities().sessionHistory).toBe('current-run-only');
		});
	});

	describe('dsh read-models: 读取内置与配置模型', () => {
		it('returns default deepseek-chat and deepseek-reasoner models when no config file exists', async () => {
			const mockFs = {
				readFile: vi.fn(async () => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				}),
				stat: vi.fn(async () => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				}),
			};

			const result = await readDshModels({
				fs: mockFs,
				homedir: '/home/tester',
			});

			expect(result.models.map((m) => m.id)).toContain('deepseek-chat');
			expect(result.models.map((m) => m.id)).toContain('deepseek-reasoner');
			expect(result.isPartial).toBe(false);
		});

		it('reads user configured model from ~/.dsh/config.json', async () => {
			const mockFs = {
				readFile: vi.fn(async () =>
					JSON.stringify({
						model: 'deepseek-coder-v2',
					}),
				),
				stat: vi.fn(async () => ({ mtimeMs: 12345 })),
			};

			const result = await readModels({
				fs: mockFs,
				homedir: '/home/tester',
			});

			expect(result.currentConfigModel).toBe('deepseek-coder-v2');
			expect(result.models.map((m) => m.id)).toContain('deepseek-coder-v2');
		});
	});

	describe('厂商事件字符串隔离 (AC 1 & Architecture)', () => {
		it('covers all dsh vendor strings in DSH_VENDOR_EVENT_STRINGS', () => {
			const dshSource = readFileSync(join(daemonSrc, 'adapters/dsh/map-events.ts'), 'utf8');
			const caseRegex = /case\s+['"]([^'"]+)['"]/g;
			const casesInFile = new Set<string>();

			let match: RegExpExecArray | null = caseRegex.exec(dshSource);
			while (match !== null) {
				if (match[1] !== undefined) {
					casesInFile.add(match[1]);
				}
				match = caseRegex.exec(dshSource);
			}

			for (const caseStr of casesInFile) {
				expect(
					DSH_VENDOR_EVENT_STRINGS,
					`Expected DSH_VENDOR_EVENT_STRINGS to cover case literal "${caseStr}"`,
				).toContain(caseStr);
				expect(isKnownDshEventType(caseStr)).toBe(true);
			}
		});

		it('asserts dsh vendor event strings do not leak into service, jobs, or http layers', () => {
			const targetDirectories = ['service', 'jobs', 'http'];
			const violations: { file: string; match: string }[] = [];

			for (const dirName of targetDirectories) {
				const fullDirPath = join(daemonSrc, dirName);
				const files = collectTypeScriptFiles(fullDirPath);

				for (const filePath of files) {
					const content = readFileSync(filePath, 'utf8');
					for (const vendorString of DSH_VENDOR_EVENT_STRINGS) {
						if (content.includes(`'${vendorString}'`) || content.includes(`"${vendorString}"`)) {
							violations.push({
								file: relative(daemonSrc, filePath).replaceAll('\\', '/'),
								match: vendorString,
							});
						}
					}
				}
			}

			expect(violations).toEqual([]);
		});
	});
});
