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
	mapGenericAcpEvents,
	parseAndMapGenericAcpLine,
} from '../../src/adapters/generic-acp/map-events.ts';
import { readGenericAcpModels, readModels } from '../../src/adapters/generic-acp/read-models.ts';
import { checkAgentAcpSupport } from '../../src/adapters/generic-acp/support.ts';
import { mapGrokEvents } from '../../src/adapters/grok/map-events.ts';
import type {
	AgentRegistry,
	AgentRegistryReloadResult,
	AgentRegistrySnapshot,
	UpdateOverridesResult,
} from '../../src/config/registry.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { ExecutableFileSystem, PlatformHostInputs } from '../../src/platform/contract.ts';
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

	describe('AC 7 & E-187 & R5: 通用 ACP 适配器作为第 6 家及以后的兜底入口与接入校验', () => {
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

		it('R5: throws AppError with E_VALIDATION on empty command and execPath', () => {
			let thrownError: unknown;
			try {
				buildGenericAcpLaunchSpec({
					runId: 'acp-run-fail',
					cwd: '/workspace/project',
					command: '  ',
				});
			} catch (err) {
				thrownError = err;
			}

			expect(thrownError).toBeInstanceOf(AppError);
			expect((thrownError as AppError).code).toBe('E_VALIDATION');
			expect((thrownError as AppError).message).toContain(
				'requires a non-empty command or execPath',
			);
		});

		it('E-187 & R6: unambiguously marks unregistered agents without ACP entry as status=unsupported', () => {
			const check = checkAgentAcpSupport({
				agentId: 'unknown-agent-7',
				isRegistered: false,
				hasAcpEntry: false,
			});

			expect(check.supported).toBe(false);
			expect(check.status).toBe('unsupported'); // R6: status is 'unsupported' enum
			expect(check.reason).toContain('is not registered and provides no ACP launch command');
		});

		it('E-187 & R6: marks agents with ACP entry command as status=supported', () => {
			const check = checkAgentAcpSupport({
				agentId: 'custom-acp-agent',
				isRegistered: false,
				launchCommand: 'custom-acp --stdio',
			});

			expect(check.supported).toBe(true);
			expect(check.status).toBe('supported'); // R6: status is 'supported' enum
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
					ok: true,
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

	describe('ACP 事件映射与跨适配器契约对齐 (R1)', () => {
		it('unpacks params.update.sessionUpdate as primary backbone with vendor attached', () => {
			const rawPacket = {
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-123',
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: {
							type: 'text',
							text: 'Hello from ACP v1 server',
						},
					},
				},
			};

			const events = mapGenericAcpEvents(rawPacket, { runId: 'run-acp-1' });
			expect(events.length).toBe(1);
			expect(events[0]?.kind).toBe('agent_message_chunk');
			expect(events[0]?.payload.chunk).toBe('Hello from ACP v1 server');
			expect(events[0]?.payload.vendor).toEqual(rawPacket);
		});

		it('R1 cross-adapter contract: mapGenericAcpEvents matches mapGrokEvents across all 5 ACP v1 packets', () => {
			const fivePackets = [
				// 1. agent_message_chunk
				{
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						sessionId: 'sess-test',
						update: {
							sessionUpdate: 'agent_message_chunk',
							content: { text: 'chunk content text' },
						},
					},
				},
				// 2. agent_thought_chunk
				{
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						sessionId: 'sess-test',
						update: {
							sessionUpdate: 'agent_thought_chunk',
							content: { text: 'thought content text' },
						},
					},
				},
				// 3. tool_call
				{
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						sessionId: 'sess-test',
						update: {
							sessionUpdate: 'tool_call',
							toolCallId: 'tc-001',
							title: 'read_file',
							rawInput: { path: 'file.txt' },
						},
					},
				},
				// 4. tool_call_update
				{
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						sessionId: 'sess-test',
						update: {
							sessionUpdate: 'tool_call_update',
							toolCallId: 'tc-001',
							rawOutput: { lines: 10 },
						},
					},
				},
				// 5. plan
				{
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						sessionId: 'sess-test',
						update: {
							sessionUpdate: 'plan',
							entries: [
								{ content: 'Inspect code', status: 'completed' },
								{ content: 'Write tests', status: 'in_progress' },
							],
						},
					},
				},
			];

			for (const packet of fivePackets) {
				const genericEvents = mapGenericAcpEvents(packet, { runId: 'test-run' });
				const grokEvents = mapGrokEvents(packet, { runId: 'test-run' });

				expect(genericEvents.length).toBeGreaterThan(0);
				expect(genericEvents.length).toBe(grokEvents.length);

				for (let i = 0; i < genericEvents.length; i++) {
					const genEv = genericEvents[i];
					const grokEv = grokEvents[i];

					// Assert kind is identical
					expect(genEv?.kind).toBe(grokEv?.kind);

					// Assert payload key sets match exactly
					const genKeys = Object.keys(genEv?.payload ?? {}).sort();
					const grokKeys = Object.keys(grokEv?.payload ?? {}).sort();

					// Check core keys alignment:
					// chunk for chunks, callId/tool/input for tool_call, callId/output for update, entries for plan
					if (genEv?.kind === 'agent_message_chunk' || genEv?.kind === 'agent_thought_chunk') {
						expect(genKeys).toContain('chunk');
						expect(grokKeys).toContain('chunk');
						expect(genEv?.payload.chunk).toBe(grokEv?.payload.chunk);
					} else if (genEv?.kind === 'tool_call') {
						expect(genKeys).toContain('callId');
						expect(genKeys).toContain('tool');
						expect(genKeys).toContain('input');
						expect(genEv?.payload.callId).toBe(grokEv?.payload.callId);
						expect(genEv?.payload.tool).toBe(grokEv?.payload.tool);
					} else if (genEv?.kind === 'tool_call_update') {
						expect(genKeys).toContain('callId');
						expect(genKeys).toContain('output');
						expect(genEv?.payload.callId).toBe(grokEv?.payload.callId);
					} else if (genEv?.kind === 'plan') {
						expect(genKeys).toContain('entries');
						expect(grokKeys).toContain('entries');
					}
				}
			}
		});

		it('handles available_commands_update', () => {
			const cmdLine = JSON.stringify({
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'available_commands_update',
						availableCommands: ['/help', '/clear'],
					},
				},
			});
			const events = mapGenericAcpEvents(cmdLine);
			expect(events[0]?.kind).toBe('available_commands_update');
			expect(events[0]?.payload.commands).toEqual(['/help', '/clear']);
		});

		it('does not emit empty chunk when content text cannot be extracted (R1)', () => {
			const emptyPacket = {
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: {}, // No text
					},
				},
			};
			const events = mapGenericAcpEvents(emptyPacket);
			expect(events).toEqual([]);
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
