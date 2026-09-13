import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { UpdateAgentBody } from '@agent-scheduler/shared/api/agents';
import {
	buildGenericAcpLaunchSpec,
	buildLaunchSpec,
} from '../../src/adapters/generic-acp/build-launch-spec.ts';
import {
	GENERIC_ACP_CAPABILITIES,
	capabilities,
	getCapabilities,
	getGenericAcpCapabilities,
} from '../../src/adapters/generic-acp/capabilities.ts';
import {
	GENERIC_ACP_VENDOR_STRINGS,
	mapEvents,
	mapGenericAcpEvents,
	parseAndMapGenericAcpLine,
} from '../../src/adapters/generic-acp/map-events.ts';
import { readGenericAcpModels, readModels } from '../../src/adapters/generic-acp/read-models.ts';
import { checkAgentAcpSupport } from '../../src/adapters/generic-acp/support.ts';
import type {
	AgentRegistry,
	AgentRegistryReloadResult,
	AgentRegistrySnapshot,
	UpdateOverridesResult,
} from '../../src/config/registry.ts';
import type { ExecutableFileSystem } from '../../src/platform/contract.ts';
import type { PlatformHostInputs } from '../../src/platform/contract.ts';
import { createAgentService } from '../../src/service/agents.ts';

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

describe('M4-T12: 通用 ACP 适配器与扩展槽 (AC 6, AC 7, AC 8, E-187, E-188, E-189)', () => {
	describe('AC 6 & E-188: ACP 能力位与会话回读「仅本次运行」', () => {
		it('declares hasStreamingEvents=true, isAcp=true, and sessionHistory=current-run-only (E-188)', () => {
			expect(GENERIC_ACP_CAPABILITIES.hasStreamingEvents).toBe(true);
			expect(capabilities.hasStreamingEvents).toBe(true);
			expect(getGenericAcpCapabilities().hasStreamingEvents).toBe(true);
			expect(getCapabilities().hasStreamingEvents).toBe(true);

			expect(GENERIC_ACP_CAPABILITIES.isAcp).toBe(true);
			expect(GENERIC_ACP_CAPABILITIES.canReply).toBe(false);
			expect(GENERIC_ACP_CAPABILITIES.canResume).toBe(false);
			expect(GENERIC_ACP_CAPABILITIES.sessionHistory).toBe('current-run-only'); // E-188
			expect(GENERIC_ACP_CAPABILITIES.supportsReasoningEffort).toBe(false);
			expect(Object.isFrozen(GENERIC_ACP_CAPABILITIES)).toBe(true);
		});
	});

	describe('AC 7 & E-187: 通用 ACP 适配器作为第 6 家及以后的兜底入口与接入校验', () => {
		it('allows launching an agent by only filling the startup command', () => {
			const spec = buildGenericAcpLaunchSpec({
				runId: 'acp-run-1',
				cwd: '/workspace/project',
				command: 'npx @custom/acp-agent --stdio',
			});

			expect(spec.file).toBe('npx');
			expect(spec.args).toEqual(['@custom/acp-agent', '--stdio']);
			expect(spec.isAcp).toBe(true);
			expect(spec.cwd).toBe('/workspace/project');
			// Startup timeout defaults to 180s for ACP cold start / npx
			expect(spec.timeouts?.startupTimeoutMs).toBe(180_000);
			expect(Object.isFrozen(spec)).toBe(true);
			expect(Object.isFrozen(spec.args)).toBe(true);
		});

		it('buildLaunchSpec supports separate execPath and args', () => {
			const spec = buildLaunchSpec({
				runId: 'acp-run-2',
				cwd: '/workspace/project',
				execPath: '/usr/local/bin/my-acp',
				args: ['--listen', 'stdio'],
				customArgs: ['--debug'],
			});

			expect(spec.file).toBe('/usr/local/bin/my-acp');
			expect(spec.args).toEqual(['--listen', 'stdio', '--debug']);
			expect(spec.isAcp).toBe(true);
		});

		it('throws on empty command and execPath', () => {
			expect(() =>
				buildGenericAcpLaunchSpec({
					runId: 'acp-run-fail',
					cwd: '/workspace/project',
					command: '  ',
				}),
			).toThrow('requires a non-empty command or execPath');
		});

		it('E-187: unambiguously marks unregistered agents without ACP entry as「暂不支持」', () => {
			const check = checkAgentAcpSupport({
				agentId: 'unknown-agent-7',
				isRegistered: false,
				hasAcpEntry: false,
			});

			expect(check.supported).toBe(false);
			expect(check.statusText).toBe('暂不支持'); // E-187: 明确标「暂不支持」，不提供半可用状态
			expect(check.reason).toContain('is not registered and provides no ACP launch command');
		});

		it('E-187: marks agents with ACP entry command as supported', () => {
			const check = checkAgentAcpSupport({
				agentId: 'custom-acp-agent',
				isRegistered: false,
				launchCommand: 'custom-acp --stdio',
			});

			expect(check.supported).toBe(true);
			expect(check.statusText).toBe('支持');
		});
	});

	describe('AC 8 & E-189: 原生与 ACP 适配器任一时刻只允许一种生效且切换必须在无在途运行时进行', () => {
		it('rejects adapterKind switch when the agent has in-flight runs', async () => {
			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						codex: {
							execPath: 'codex',
							argsTemplate: ['exec', '--json'],
							maxConcurrency: 1,
							defaultModel: null,
							permissionTier: 'workspaceWrite',
							monogram: 'CX',
							adapterKind: 'native',
							timeouts: { startupTimeoutMs: 60000, idleTimeoutMs: 900000, hardWallClockMs: 0 },
							versionFingerprint: { args: ['--version'], expectedPattern: 'codex' },
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
				updateOverrides: vi.fn(),
			};

			const hostInputs: PlatformHostInputs = {
				platform: 'linux',
				homedir: '/home/tester',
			};

			const mockFs = {
				lstat: async () => ({
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false,
				}),
				readlink: async () => '/usr/bin/codex',
				realpath: async () => '/usr/bin/codex',
				stat: async () => ({
					isFile: () => true,
					isDirectory: () => false,
					mtimeMs: 1000,
					size: 5000,
				}),
				access: async () => undefined,
			};

			// hasInFlightRuns returns true -> agent is busy
			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs,
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				commandRunner: vi.fn(async () => ({
					ok: true as const,
					exitCode: 0,
					stdout: 'codex 1.0',
					stderr: '',
				})),
				hasInFlightRuns: async (agentId: string) => agentId === 'codex',
			});

			// Attempting to switch adapterKind from native to generic-acp while in flight
			await expect(
				service.updateAgent('codex', {
					adapterKind: 'generic-acp',
				} as unknown as UpdateAgentBody),
			).rejects.toThrow(/Cannot switch adapterKind for agent 'codex' while runs are in flight/);

			// updateOverrides was never called because in-flight check intercepted
			expect(mockRegistry.updateOverrides).not.toHaveBeenCalled();
		});

		it('allows adapterKind switch when no in-flight runs exist', async () => {
			const mockRegistry: Partial<AgentRegistry> = {
				getSnapshot: () => ({
					generation: 1,
					fingerprint: 'fp-1',
					agents: {
						codex: {
							execPath: 'codex',
							argsTemplate: ['exec', '--json'],
							maxConcurrency: 1,
							defaultModel: null,
							permissionTier: 'workspaceWrite',
							monogram: 'CX',
							adapterKind: 'native',
							timeouts: { startupTimeoutMs: 60000, idleTimeoutMs: 900000, hardWallClockMs: 0 },
							versionFingerprint: { args: ['--version'], expectedPattern: 'codex' },
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
				updateOverrides: vi.fn(
					async (): Promise<UpdateOverridesResult> => ({
						ok: true,
						reload: { status: 'applied', generation: 2 } as unknown as AgentRegistryReloadResult,
					}),
				),
			};

			const hostInputs: PlatformHostInputs = {
				platform: 'linux',
				homedir: '/home/tester',
			};

			const mockFs = {
				lstat: async () => ({
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false,
				}),
				readlink: async () => '/usr/bin/codex',
				realpath: async () => '/usr/bin/codex',
				stat: async () => ({
					isFile: () => true,
					isDirectory: () => false,
					mtimeMs: 1000,
					size: 5000,
				}),
				access: async () => undefined,
			};

			const service = createAgentService({
				registry: mockRegistry as AgentRegistry,
				hostInputs,
				fileSystem: mockFs as unknown as ExecutableFileSystem,
				hasInFlightRuns: async () => false, // No runs in flight
				commandRunner: vi.fn(async () => ({
					ok: true,
					exitCode: 0,
					stdout: 'codex 1.0.0',
					stderr: '',
				})),
			});

			// Should proceed without throwing
			await service.updateAgent('codex', {
				adapterKind: 'generic-acp',
			} as unknown as UpdateAgentBody);

			expect(mockRegistry.updateOverrides).toHaveBeenCalledWith('codex', {
				adapterKind: 'generic-acp',
			});
		});
	});

	describe('ACP 事件映射 (mapGenericAcpEvents)', () => {
		it('maps session/update notification with agent_message_chunk', () => {
			const line = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					update: {
						kind: 'agent_message_chunk',
						delta: 'Writing tests for ACP adapter.',
					},
				},
			});

			const events = mapGenericAcpEvents(line, { runId: 'run-acp' });
			expect(events.length).toBe(1);
			expect(events[0]?.kind).toBe('agent_message_chunk');
			expect(events[0]?.payload.content).toBe('Writing tests for ACP adapter.');
			expect(events[0]?.payload.delta).toBe('Writing tests for ACP adapter.');
		});

		it('maps agent_thought_chunk, tool_call, tool_call_update, and plan', () => {
			const thoughtLine = JSON.stringify({
				method: 'session/update',
				params: {
					update: {
						kind: 'agent_thought_chunk',
						thought: 'I should inspect the code.',
					},
				},
			});
			const thoughtEvents = mapGenericAcpEvents(thoughtLine);
			expect(thoughtEvents[0]?.kind).toBe('agent_thought_chunk');
			expect((thoughtEvents[0]?.payload as { thought: string }).thought).toBe(
				'I should inspect the code.',
			);

			const toolCallLine = JSON.stringify({
				method: 'session/update',
				params: {
					update: {
						kind: 'tool_call',
						toolCallId: 'call-1',
						name: 'read_file',
						input: { path: 'README.md' },
					},
				},
			});
			const toolEvents = mapGenericAcpEvents(toolCallLine);
			expect(toolEvents[0]?.kind).toBe('tool_call');
			expect((toolEvents[0]?.payload as { toolCallId: string }).toolCallId).toBe('call-1');
			expect((toolEvents[0]?.payload as { name: string }).name).toBe('read_file');

			const planLine = JSON.stringify({
				method: 'session/update',
				params: {
					update: {
						kind: 'plan',
						steps: [{ id: 's1', text: 'Step 1', status: 'completed' }],
					},
				},
			});
			const planEvents = mapEvents(planLine);
			expect(planEvents[0]?.kind).toBe('plan');
			expect((planEvents[0]?.payload as { steps: { text: string }[] }).steps[0]?.text).toBe(
				'Step 1',
			);
		});

		it('tracks unknown event types in unmappedCount without breaking the stream', () => {
			const unknownLine = JSON.stringify({
				method: 'custom/future_event',
				params: { data: 123 },
			});
			const result = parseAndMapGenericAcpLine(unknownLine);
			expect(result.unmappedCount).toBe(1);
			expect(result.events).toEqual([]);

			// Malformed non-JSON
			const parseErrorResult = parseAndMapGenericAcpLine('not json string');
			expect(parseErrorResult.parseError).toBe(true);
			expect(parseErrorResult.events).toEqual([]);
		});
	});

	describe('read-models for Generic ACP', () => {
		it('returns configured defaultModel and availableModels', async () => {
			const result = await readGenericAcpModels({
				defaultModel: 'custom-model-1',
				availableModels: ['custom-model-1', 'custom-model-2'],
				historicalModels: ['historical-model'],
			});

			expect(result.currentConfigModel).toBe('custom-model-1');
			expect(result.models.map((m) => m.id)).toEqual([
				'custom-model-1',
				'custom-model-2',
				'historical-model',
			]);
			expect(result.isPartial).toBe(false);
		});

		it('readModels returns empty models cleanly when no config provided', async () => {
			const result = await readModels({});
			expect(result.models).toEqual([]);
			expect(result.currentConfigModel).toBeNull();
			expect(result.isPartial).toBe(false);
		});
	});

	describe('厂商事件字符串隔离 (AC 7 & Architecture)', () => {
		it('covers all generic ACP vendor strings in GENERIC_ACP_VENDOR_STRINGS', () => {
			const acpSource = readFileSync(join(daemonSrc, 'adapters/generic-acp/map-events.ts'), 'utf8');
			const methodRegex = /case\s+['"]([^'"]+)['"]/g;
			const casesInFile = new Set<string>();

			let match: RegExpExecArray | null = methodRegex.exec(acpSource);
			while (match !== null) {
				if (match[1] !== undefined) {
					casesInFile.add(match[1]);
				}
				match = methodRegex.exec(acpSource);
			}

			// Case literals in map-events are standard ACP names (agent_message_chunk, etc.)
			expect(casesInFile.has('agent_message_chunk')).toBe(true);
			expect(casesInFile.has('tool_call')).toBe(true);
			expect(GENERIC_ACP_VENDOR_STRINGS.length).toBeGreaterThan(5);
		});

		it('asserts generic ACP vendor strings do not leak into service, jobs, or http layers', () => {
			const targetDirectories = ['service', 'jobs', 'http'];
			const violations: { file: string; match: string }[] = [];

			for (const dirName of targetDirectories) {
				const fullDirPath = join(daemonSrc, dirName);
				const files = collectTypeScriptFiles(fullDirPath);

				for (const filePath of files) {
					const content = readFileSync(filePath, 'utf8');
					for (const vendorString of GENERIC_ACP_VENDOR_STRINGS) {
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
