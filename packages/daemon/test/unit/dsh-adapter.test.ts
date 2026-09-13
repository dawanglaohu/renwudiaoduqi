import { type Stats, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

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
	mapEvents,
	parseAndMapDshLine,
} from '../../src/adapters/dsh/map-events.ts';
import { readDshModels, readModels } from '../../src/adapters/dsh/read-models.ts';
import { runDshSmokeTest } from '../../src/adapters/dsh/smoke.ts';
import { matchVersionFingerprint, probeAgent } from '../../src/adapters/probe.ts';
import { BUILT_IN_AGENT_DEFAULTS, BUILT_IN_AGENT_IDS } from '../../src/config/defaults.ts';
import { PERMISSION_TIERS } from '../../src/domain/permission-tier.ts';
import type { PlatformHostInputs } from '../../src/platform/contract.ts';

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
			// Binary path without .js
			const customBinarySpec = buildDshLaunchSpec({
				runId: 'dsh-custom-bin',
				cwd: '/workspace/project',
				execPath: '/opt/deepseek/bin/dsh',
				prompt: 'run task',
			});
			expect(customBinarySpec.file).toBe('/opt/deepseek/bin/dsh');
			expect(customBinarySpec.args[0]).toBe('--profile');
			expect(customBinarySpec.args[1]).toBe('headless');

			// Custom .js path executed via node
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

	describe('AC 2 & E-253: 能力位 hasStreamingEvents 置假与禁止伪造中间事件', () => {
		it('strictly sets hasStreamingEvents=false and declares current-run-only session history', () => {
			expect(DSH_CAPABILITIES.hasStreamingEvents).toBe(false);
			expect(capabilities.hasStreamingEvents).toBe(false);
			expect(getDshCapabilities().hasStreamingEvents).toBe(false);
			expect(getCapabilities().hasStreamingEvents).toBe(false);

			expect(DSH_CAPABILITIES.canReply).toBe(false);
			expect(DSH_CAPABILITIES.canResume).toBe(false);
			expect(DSH_CAPABILITIES.supportsReasoningEffort).toBe(false);
			expect(DSH_CAPABILITIES.sessionHistory).toBe('current-run-only');
			expect(DSH_CAPABILITIES.mode).toBe('headless');
			expect(Object.isFrozen(DSH_CAPABILITIES)).toBe(true);
		});

		it('mapDshEvents never fabricates fake intermediate events (no fake tool_call, plan, or thought)', () => {
			const rawStdoutLines = ['Starting execution...', 'Model generated final analysis.', 'OK'];

			for (const line of rawStdoutLines) {
				const events = mapDshEvents(line, { runId: 'run-1', taskId: 'task-1' });
				// Must only emit agent_message_chunk for terminal text, NEVER tool_call or plan
				expect(events.length).toBe(1);
				expect(events[0]?.kind).toBe('agent_message_chunk');
				expect(events[0]?.payload.content).toBe(line);
				expect(events[0]?.payload.delta).toBe(line);

				// Verify NO fake tool_call, plan, or agent_thought_chunk
				expect(events.some((e) => e.kind === 'tool_call')).toBe(false);
				expect(events.some((e) => e.kind === 'plan')).toBe(false);
				expect(events.some((e) => e.kind === 'agent_thought_chunk')).toBe(false);
			}
		});

		it('handles structured dsh completion JSON lines without intermediate steps', () => {
			const completionLine = JSON.stringify({
				method: 'turn/end',
				text: 'Task completed successfully in HEAD.',
			});

			const events = mapDshEvents(completionLine, { runId: 'run-1' });
			expect(events.length).toBe(1);
			expect(events[0]?.kind).toBe('agent_message_chunk');
			expect(events[0]?.payload.content).toBe('Task completed successfully in HEAD.');

			// Empty or non-content turn events produce no fake events
			const startLine = JSON.stringify({ method: 'turn/started' });
			const startEvents = mapEvents(startLine);
			expect(startEvents).toEqual([]);
		});

		it('parseAndMapDshLine tracks unknown vendor events in unmappedCount without crashing', () => {
			const unknownLine = JSON.stringify({ method: 'unknown/dsh/method', params: {} });
			const result = parseAndMapDshLine(unknownLine);
			expect(result.unmappedCount).toBe(1);
			expect(result.events).toEqual([]);

			const emptyResult = parseAndMapDshLine('   ');
			expect(emptyResult.events).toEqual([]);
			expect(emptyResult.unmappedCount).toBe(0);
		});
	});

	describe('AC 3 & E-191 & E-28: 启用前过探测与冒烟任务', () => {
		it('passes smoke test when dsh succeeds with exit code 0, empty stderr, and stdout text', async () => {
			const mockRunner = vi.fn(
				async (_params: import('../../src/adapters/dsh/smoke.ts').DshSmokeRunnerParams) => ({
					ok: true,
					exitCode: 0,
					stdout: 'OK\n',
					stderr: '',
				}),
			);

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

		it('E-191: fails smoke test when dsh exits non-zero and reports failure reason', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: false,
				exitCode: 1,
				stdout: '',
				stderr: 'Error: invalid session format',
			}));

			const result = await runDshSmokeTest({ runner: mockRunner });
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('non-zero exit code: 1');
		});

		it('E-191: fails smoke test when successful exit code has non-empty stderr (contract violation)', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'Partial output',
				stderr: 'Warning: deprecated profile combination',
			}));

			const result = await runDshSmokeTest({ runner: mockRunner });
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('contract violation: expected empty stderr');
		});

		it('E-191: fails smoke test when stdout is empty', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: '   \n',
				stderr: '',
			}));

			const result = await runDshSmokeTest({ runner: mockRunner });
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('expected terminal assistant text on stdout');
		});

		it('E-191: fails smoke test when process fails to spawn (ENOENT)', async () => {
			const mockRunner = vi.fn(async () => {
				throw new Error('spawn dsh ENOENT');
			});

			const result = await runDshSmokeTest({ runner: mockRunner });
			expect(result.ok).toBe(false);
			expect(result.reason).toContain('dsh process failed to start: spawn dsh ENOENT');
		});
	});

	describe('AC 5 & E-194: 版本超出注册表已知区间时允许启用但常驻提示「版本未验证」', () => {
		it('allows enablement with canDispatch=true and warning banner when version exceeds range', () => {
			const comparison = matchVersionFingerprint('dsh 0.3.5', '\\bdsh\\b', {
				agentId: 'dsh',
				versionRange: { min: '0.1.0', max: '0.1.2' },
			});

			expect(comparison.isStrictMatch).toBe(true);
			expect(comparison.inVersionRange).toBe(false);
			// Under E-194, matched is false for strict range, but isStrictMatch recognizes the tool
			expect(comparison.matched).toBe(false);
		});

		it('probeAgent returns status=warning, canDispatch=true, and warning banner when version out of range', async () => {
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'dsh 0.3.0',
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
				versionRange: { min: '0.1.0', max: '0.1.2' },
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('warning');
			expect(result.canDispatch).toBe(true); // E-194: 允许启用
			expect(result.warningBanner).toBeDefined();
			expect(result.warningBanner?.message).toBe('版本未验证'); // E-194: 常驻提示「版本未验证」
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
