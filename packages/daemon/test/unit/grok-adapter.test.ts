import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACP_EVENT_KINDS } from '@agent-scheduler/shared/api/events';
import { describe, expect, it, vi } from 'vitest';
import { buildGrokLaunchSpec, buildLaunchSpec } from '../../src/adapters/grok/build-launch-spec.ts';
import {
	GROK_CAPABILITIES,
	capabilities,
	getCapabilities,
	getGrokCapabilities,
} from '../../src/adapters/grok/capabilities.ts';
import {
	GROK_VENDOR_EVENT_STRINGS,
	createGrokEventTracker,
	extractGrokTokenUsage,
	isKnownGrokEventType,
	mapEvents,
	mapGrokEvents,
	parseAndMapGrokLine,
} from '../../src/adapters/grok/map-events.ts';
import {
	buildGrokExportArgs,
	buildGrokSessionsListArgs,
	buildGrokSessionsSearchArgs,
	exportGrokSession,
	listGrokSessions,
	parseGrokSessionsTable,
	searchGrokSessions,
} from '../../src/adapters/grok/sessions.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import { PERMISSION_TIERS } from '../../src/domain/permission-tier.ts';

describe('M4-T11 grok 原生适配器', () => {
	describe('1. buildLaunchSpec (AC 1, AC 3, AC 4, R1)', () => {
		it('AC 1: enforces `--output-format streaming-json` for ACP native output', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-1',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				prompt: 'fix the bug',
			});

			expect(spec.file).toBe('/usr/bin/grok');
			expect(spec.args).toContain('--output-format');
			const idx = spec.args.indexOf('--output-format');
			expect(spec.args[idx + 1]).toBe('streaming-json');
			expect(spec.isAcp).toBe(true);
			expect(Object.isFrozen(spec)).toBe(true);
			expect(Object.isFrozen(spec.args)).toBe(true);
		});

		it('AC 1: overwrites mismatched --output-format in customArgs or template to streaming-json', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-2',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				prompt: 'fix the bug',
				argsTemplate: ['--output-format', 'plain'],
			});

			const idx = spec.args.indexOf('--output-format');
			expect(spec.args[idx + 1]).toBe('streaming-json');
		});

		it('R1 (a): with BUILT_IN_AGENT_DEFAULTS.grok.argsTemplate, prompt lands on argv (-p value == prompt)', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-builtin-p',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				prompt: 'do the task',
				model: 'grok-4',
				argsTemplate: BUILT_IN_AGENT_DEFAULTS.grok.argsTemplate,
			});

			expect(spec.args).toContain('-p');
			const pIdx = spec.args.indexOf('-p');
			expect(spec.args[pIdx + 1]).toBe('do the task');
			expect(spec.args).toContain('--model');
			expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('grok-4');
		});

		it('R1 (a): with BUILT_IN_AGENT_DEFAULTS.grok.argsTemplate, promptFile lands on argv (--prompt-file value == promptFile)', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-builtin-pf',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				promptFile: '/tmp/prompts/task-1.md',
				model: 'grok-4',
				argsTemplate: BUILT_IN_AGENT_DEFAULTS.grok.argsTemplate,
			});

			expect(spec.args).toContain('--prompt-file');
			const pfIdx = spec.args.indexOf('--prompt-file');
			expect(spec.args[pfIdx + 1]).toBe('/tmp/prompts/task-1.md');
			expect(spec.args).not.toContain('--single');
			expect(spec.args).not.toContain('-p');
		});

		it('R1 (b): with BUILT_IN_AGENT_DEFAULTS.grok.argsTemplate and model=null, argv does NOT contain `--model` (E-35)', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-builtin-no-model',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				prompt: 'do the task',
				model: null,
				argsTemplate: BUILT_IN_AGENT_DEFAULTS.grok.argsTemplate,
			});

			expect(spec.args).not.toContain('--model');
			expect(spec.args).not.toContain('-m');
			// Prompt still lands
			const pIdx = spec.args.indexOf('-p');
			expect(spec.args[pIdx + 1]).toBe('do the task');
		});

		it('R1 (c): with argsTemplate containing {session_dir}, argv has no element containing "{"', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-session-dir',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				prompt: 'test',
				sessionDir: '/tmp/sessions/grok-sess-1',
				argsTemplate: ['--session-dir', '{session_dir}'],
			});

			const sessIdx = spec.args.indexOf('--session-dir');
			expect(sessIdx).not.toBe(-1);
			expect(spec.args[sessIdx + 1]).toBe('/tmp/sessions/grok-sess-1');
			for (const arg of spec.args) {
				expect(arg).not.toContain('{');
			}
		});

		it('R1 (d): template with unknown variable {session_id} returns structured failure (E_VALIDATION), not passed verbatim', () => {
			expect(() =>
				buildGrokLaunchSpec({
					runId: 'run-unknown-var',
					cwd: '/workspace/test',
					execPath: '/usr/bin/grok',
					argsTemplate: ['--custom', '{session_id}'],
				}),
			).toThrowError(/Unknown template variable/);
		});

		it('R1: rejects missing or empty execPath with E_VALIDATION', () => {
			expect(() =>
				buildGrokLaunchSpec({
					runId: 'run-no-exec',
					cwd: '/workspace/test',
					execPath: '',
				}),
			).toThrowError(/execPath is required/);

			expect(() =>
				buildGrokLaunchSpec({
					runId: 'run-undefined-exec',
					cwd: '/workspace/test',
				}),
			).toThrowError(/execPath is required/);
		});

		it('maps three permission tiers correctly to `--permission-mode`', () => {
			const readOnlySpec = buildGrokLaunchSpec({
				runId: 'run-ro',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				permissionTier: PERMISSION_TIERS.READ_ONLY,
			});
			expect(readOnlySpec.args).toContain('--permission-mode');
			const roIdx = readOnlySpec.args.indexOf('--permission-mode');
			expect(readOnlySpec.args[roIdx + 1]).toBe('plan');

			const writeSpec = buildGrokLaunchSpec({
				runId: 'run-write',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				permissionTier: PERMISSION_TIERS.WORKSPACE_WRITE,
			});
			const writeIdx = writeSpec.args.indexOf('--permission-mode');
			expect(writeSpec.args[writeIdx + 1]).toBe('acceptEdits');

			const unresSpec = buildGrokLaunchSpec({
				runId: 'run-unres',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				permissionTier: PERMISSION_TIERS.UNRESTRICTED,
			});
			const unresIdx = unresSpec.args.indexOf('--permission-mode');
			expect(unresSpec.args[unresIdx + 1]).toBe('bypassPermissions');
		});

		it('maps reasoning effort tiers to `--reasoning-effort`', () => {
			const lowSpec = buildGrokLaunchSpec({
				runId: 'run-low',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				effortTier: 'low',
			});
			expect(lowSpec.args).toContain('--reasoning-effort');
			const lowIdx = lowSpec.args.indexOf('--reasoning-effort');
			expect(lowSpec.args[lowIdx + 1]).toBe('low');

			const medSpec = buildGrokLaunchSpec({
				runId: 'run-med',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				effortTier: 'medium',
			});
			const medIdx = medSpec.args.indexOf('--reasoning-effort');
			expect(medSpec.args[medIdx + 1]).toBe('medium');

			const highSpec = buildGrokLaunchSpec({
				runId: 'run-high',
				cwd: '/workspace/test',
				execPath: '/usr/bin/grok',
				effortTier: 'high',
			});
			const highIdx = highSpec.args.indexOf('--reasoning-effort');
			expect(highIdx).not.toBe(-1);
			expect(highSpec.args[highIdx + 1]).toBe('high');
		});

		it('passes model, session ID, worktree, and customArgs', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-full',
				cwd: '/workspace/test',
				execPath: '/custom/bin/grok',
				model: 'grok-4.6',
				sessionId: '01a08004-0fbb-78a3-b1f3-a54fbfe035c8',
				worktree: 'feat-x',
				worktreeRef: 'main',
				customArgs: ['--debug'],
			});

			expect(spec.file).toBe('/custom/bin/grok');
			expect(spec.args).toContain('--model');
			expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('grok-4.6');
			expect(spec.args).toContain('--session-id');
			expect(spec.args[spec.args.indexOf('--session-id') + 1]).toBe(
				'01a08004-0fbb-78a3-b1f3-a54fbfe035c8',
			);
			expect(spec.args).toContain('--worktree');
			expect(spec.args[spec.args.indexOf('--worktree') + 1]).toBe('feat-x');
			expect(spec.args).toContain('--worktree-ref');
			expect(spec.args[spec.args.indexOf('--worktree-ref') + 1]).toBe('main');
			expect(spec.args).toContain('--debug');
		});

		it('exports alias buildLaunchSpec', () => {
			expect(buildLaunchSpec).toBe(buildGrokLaunchSpec);
		});
	});

	describe('2. capabilities', () => {
		it('exports frozen Grok capabilities matching ACP native specification', () => {
			expect(GROK_CAPABILITIES.canReply).toBe(false);
			expect(GROK_CAPABILITIES.supportsReply).toBe(false);
			expect(GROK_CAPABILITIES.hasStreamingEvents).toBe(true);
			expect(GROK_CAPABILITIES.supportsStreaming).toBe(true);
			expect(GROK_CAPABILITIES.canResume).toBe(true);
			expect(GROK_CAPABILITIES.outputFormat).toBe('streaming-json');
			expect(GROK_CAPABILITIES.nativeAcp).toBe(true);
			expect(GROK_CAPABILITIES.supportsReasoningEffort).toBe(true);
			expect(GROK_CAPABILITIES.supportsWorktree).toBe(true);
			expect(GROK_CAPABILITIES.permissionModes).toEqual([
				'plan',
				'acceptEdits',
				'bypassPermissions',
			]);

			expect(Object.isFrozen(GROK_CAPABILITIES)).toBe(true);
			expect(getGrokCapabilities()).toBe(GROK_CAPABILITIES);
			expect(capabilities).toBe(GROK_CAPABILITIES);
			expect(getCapabilities).toBe(getGrokCapabilities);
		});
	});

	describe('3. mapEvents (AC 1, AC 5, R2, R3, E-26, E-140, E-202)', () => {
		it('R2: unwraps real ACP session/update JSON-RPC shape with sessionUpdate discriminant and content object', () => {
			const tracker = createGrokEventTracker();
			const realAcpMessageLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-001',
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: {
							type: 'text',
							text: 'Real ACP streaming message chunk',
						},
					},
				},
			});

			const result = parseAndMapGrokLine(realAcpMessageLine, {
				runId: 'run-acp-1',
				tracker,
			});
			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.kind).toBe('agent_message_chunk');
			expect(result.events[0]?.payload.chunk).toBe('Real ACP streaming message chunk');
			expect(result.events[0]?.runId).toBe('run-acp-1');
			expect(result.unmappedCount).toBe(0);
			expect(tracker.unmappedCount).toBe(0);
		});

		it('R2: unwraps real ACP session/update agent_thought_chunk', () => {
			const realAcpThoughtLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-002',
					update: {
						sessionUpdate: 'agent_thought_chunk',
						content: {
							type: 'text',
							text: 'Real ACP thinking chunk',
						},
					},
				},
			});

			const events = mapGrokEvents(realAcpThoughtLine);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('agent_thought_chunk');
			expect(events[0]?.payload.chunk).toBe('Real ACP thinking chunk');
		});

		it('R2: reads tool_call with toolCallId/title/rawInput/status', () => {
			const realAcpToolCallLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-003',
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'call-xyz-99',
						title: 'readFile',
						rawInput: { path: 'package.json' },
						status: 'in_progress',
					},
				},
			});

			const events = mapGrokEvents(realAcpToolCallLine);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('tool_call');
			expect(events[0]?.payload.callId).toBe('call-xyz-99');
			expect(events[0]?.payload.tool).toBe('readFile');
			expect(events[0]?.payload.input).toEqual({ path: 'package.json' });
			expect(events[0]?.payload.status).toBe('in_progress');
		});

		it('R2: reads tool_call_update with toolCallId/status/rawOutput', () => {
			const realAcpToolUpdateLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-004',
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: 'call-xyz-99',
						status: 'completed',
						rawOutput: '{"name": "agent-scheduler"}',
					},
				},
			});

			const events = mapGrokEvents(realAcpToolUpdateLine);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('tool_call_update');
			expect(events[0]?.payload.callId).toBe('call-xyz-99');
			expect(events[0]?.payload.output).toBe('{"name": "agent-scheduler"}');
			expect(events[0]?.payload.status).toBe('completed');
			expect(events[0]?.payload.isError).toBe(false);
		});

		it('R2: reads plan with entries[].content/status/priority', () => {
			const realAcpPlanLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-005',
					update: {
						sessionUpdate: 'plan',
						entries: [
							{
								content: { type: 'text', text: 'Analyze requirements' },
								status: 'completed',
								priority: 'high',
							},
							{
								content: { type: 'text', text: 'Implement fix' },
								status: 'in_progress',
								priority: 'medium',
							},
						],
					},
				},
			});

			const events = mapGrokEvents(realAcpPlanLine);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('plan');
			expect(events[0]?.payload.entries).toEqual([
				{
					content: 'Analyze requirements',
					status: 'completed',
					priority: 'high',
				},
				{
					content: 'Implement fix',
					status: 'in_progress',
					priority: 'medium',
				},
			]);
		});

		it('R2: reads available_commands_update with availableCommands', () => {
			const realAcpCommandsLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-006',
					update: {
						sessionUpdate: 'available_commands_update',
						availableCommands: ['help', 'export', 'abort'],
					},
				},
			});

			const events = mapGrokEvents(realAcpCommandsLine);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('available_commands_update');
			expect(events[0]?.payload.commands).toEqual(['help', 'export', 'abort']);
		});

		it('R3: adapter ONLY produces ACP group events or run.permission_blocked, never fakes runtime states or exit codes', () => {
			const allowedKinds = new Set<string>([...ACP_EVENT_KINDS, 'run.permission_blocked']);

			const sampleLines = [
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						update: {
							sessionUpdate: 'agent_message_chunk',
							content: 'msg',
						},
					},
				}),
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						update: {
							sessionUpdate: 'agent_thought_chunk',
							content: 'thought',
						},
					},
				}),
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						update: {
							sessionUpdate: 'tool_call',
							toolCallId: '1',
							title: 'test',
						},
					},
				}),
				JSON.stringify({
					jsonrpc: '2.0',
					method: 'session/update',
					params: {
						update: {
							sessionUpdate: 'permission_blocked',
							tool: 'rm',
							reason: 'read-only',
						},
					},
				}),
			];

			for (const line of sampleLines) {
				const events = mapGrokEvents(line);
				for (const event of events) {
					// Strict assertion: kind MUST be in ACP group ∪ {run.permission_blocked}
					expect(allowedKinds.has(event.kind)).toBe(true);
					// Strictly no run.started, run.state_changed, or run.exited
					expect(event.kind).not.toBe('run.started');
					expect(event.kind).not.toBe('run.state_changed');
					expect(event.kind).not.toBe('run.exited');
				}
			}
		});

		it('R3: GROK_VENDOR_EVENT_STRINGS is strictly converged to ACP session/update discriminants without pi RPC names', () => {
			// Pi RPC names must NOT be in grok vendor strings
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('agent_settled');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('turn_start');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('turn_end');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('turn_complete');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('agent_start');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('session_start');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('session_complete');
			expect(GROK_VENDOR_EVENT_STRINGS).not.toContain('turn_failed');

			// ACP discriminants must be in grok vendor strings
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('session/update');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('agent_message_chunk');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('agent_thought_chunk');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('tool_call');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('tool_call_update');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('plan');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('available_commands_update');
			expect(GROK_VENDOR_EVENT_STRINGS).toContain('permission_blocked');
		});

		it('AC 5 & E-26 & R2: token usage extracted from unpacked update object, missing fields are null and NEVER 0', () => {
			const realAcpWithToken = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-tok',
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: 'message with tokens',
						usage: {
							prompt_tokens: 250,
							completion_tokens: 125,
							total_tokens: 375,
						},
					},
				},
			});

			const events = mapGrokEvents(realAcpWithToken);
			expect(events).toHaveLength(1);
			const vendor = events[0]?.payload.vendor as {
				tokenUsage?: { inputTokens: number | null; outputTokens: number | null };
			};
			expect(vendor.tokenUsage).toEqual({
				inputTokens: 250,
				outputTokens: 125,
				totalTokens: 375,
			});

			// Partial token usage: only prompt_tokens provided -> outputTokens must be null, NOT 0
			const partialTokenLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: 'partial tokens',
						usage: {
							prompt_tokens: 300,
						},
					},
				},
			});

			const partialEvents = mapGrokEvents(partialTokenLine);
			const partialVendor = partialEvents[0]?.payload.vendor as {
				tokenUsage?: {
					inputTokens: number | null;
					outputTokens: number | null;
					totalTokens: number | null;
				};
			};
			expect(partialVendor.tokenUsage?.inputTokens).toBe(300);
			expect(partialVendor.tokenUsage?.outputTokens).toBeNull();
			expect(partialVendor.tokenUsage?.totalTokens).toBeNull();
			expect(partialVendor.tokenUsage?.outputTokens).not.toBe(0);
			expect(partialVendor.tokenUsage?.totalTokens).not.toBe(0);
		});

		it('AC 5 & E-26: standalone extractGrokTokenUsage strictly returns null for missing or invalid values', () => {
			expect(extractGrokTokenUsage({})).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});

			expect(extractGrokTokenUsage({ usage: {} })).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});

			expect(
				extractGrokTokenUsage({
					usage: { prompt_tokens: 'invalid', completion_tokens: null },
				}),
			).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});
		});

		it('E-140: unparseable line returns empty array without throwing and marks parseError', () => {
			const result = parseAndMapGrokLine('invalid { json stream');
			expect(result.events).toHaveLength(0);
			expect(result.parseError).toBe(true);
			expect(result.unmappedCount).toBe(0);

			const mapped = mapGrokEvents('not a json line');
			expect(mapped).toEqual([]);
		});

		it('E-202: unknown vendor event types are dropped, counted on tracker, and never invent kinds', () => {
			const tracker = createGrokEventTracker();
			const onUnmapped = vi.fn();

			const unknownLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'unrecognized_future_discriminant',
						data: 123,
					},
				},
			});

			const result = parseAndMapGrokLine(unknownLine, { tracker, onUnmapped });
			expect(result.events).toHaveLength(0);
			expect(result.unmappedCount).toBe(1);
			expect(tracker.unmappedCount).toBe(1);
			expect(tracker.unmappedTypes).toContain('unrecognized_future_discriminant');
			expect(onUnmapped).toHaveBeenCalledWith(
				'unrecognized_future_discriminant',
				expect.any(Object),
			);
		});

		it('identifies all known vendor event strings via isKnownGrokEventType', () => {
			for (const known of GROK_VENDOR_EVENT_STRINGS) {
				expect(isKnownGrokEventType(known)).toBe(true);
			}
			expect(isKnownGrokEventType('totally_fake_event')).toBe(false);
		});

		it('exports alias mapEvents matching mapGrokEvents', () => {
			expect(mapEvents).toBe(mapGrokEvents);
		});
	});

	describe('4. sessions & export (AC 2)', () => {
		it('builds CLI argument lists for sessions list, search, and export', () => {
			const listArgs = buildGrokSessionsListArgs({ limit: 10 });
			expect(listArgs).toEqual(['sessions', 'list', '-n', '10']);

			const listArgsWithSocket = buildGrokSessionsListArgs({
				leaderSocket: '/custom/socket',
			});
			expect(listArgsWithSocket).toEqual(['sessions', 'list', '--leader-socket', '/custom/socket']);

			const searchArgs = buildGrokSessionsSearchArgs('review PR', { limit: 5 });
			expect(searchArgs).toEqual(['sessions', 'search', 'review PR', '-n', '5']);

			const exportArgs = buildGrokExportArgs('01a08004-0fbb-78a3-b1f3-a54fbfe035c8', {
				leaderSocket: '/custom/socket',
			});
			expect(exportArgs).toEqual([
				'export',
				'01a08004-0fbb-78a3-b1f3-a54fbfe035c8',
				'--leader-socket',
				'/custom/socket',
			]);
		});

		it('parses real grok sessions list tabular output into structured summaries', () => {
			const realSample = `
(no label)
SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY
01a08004-0fbb-78a3-b1f3-a54fbfe035c8  2026-09-08  2026-09-08  local  M1-T4 logstore append index slice review
01a0800b-79ae-7c10-9288-ddb61c848c75  2026-09-08  2026-09-08  local  Review and land M1-T10 daemon lock
01a08002-adc1-7a23-a477-a8508e06f499  2026-09-08  2026-09-08  local  (no summary)
01a07ff8-0074-7782-8fd6-d0636654f381  2026-09-08  2026-09-08  local  你好
`;

			const parsed = parseGrokSessionsTable(realSample);
			expect(parsed).toHaveLength(4);

			expect(parsed[0]).toEqual({
				id: '01a08004-0fbb-78a3-b1f3-a54fbfe035c8',
				created: '2026-09-08',
				updated: '2026-09-08',
				status: 'local',
				summary: 'M1-T4 logstore append index slice review',
			});

			expect(parsed[1]).toEqual({
				id: '01a0800b-79ae-7c10-9288-ddb61c848c75',
				created: '2026-09-08',
				updated: '2026-09-08',
				status: 'local',
				summary: 'Review and land M1-T10 daemon lock',
			});

			// (no summary) is normalized to empty string
			expect(parsed[2]).toEqual({
				id: '01a08002-adc1-7a23-a477-a8508e06f499',
				created: '2026-09-08',
				updated: '2026-09-08',
				status: 'local',
				summary: '',
			});

			expect(parsed[3]).toEqual({
				id: '01a07ff8-0074-7782-8fd6-d0636654f381',
				created: '2026-09-08',
				updated: '2026-09-08',
				status: 'local',
				summary: '你好',
			});
		});

		it('parses JSON format sessions output if provided', () => {
			const jsonSample = JSON.stringify([
				{
					sessionId: 'sess-1',
					createdAt: '2026-09-10',
					updatedAt: '2026-09-11',
					status: 'active',
					title: 'Sample session',
				},
			]);

			const parsed = parseGrokSessionsTable(jsonSample);
			expect(parsed).toHaveLength(1);
			expect(parsed[0]).toEqual({
				id: 'sess-1',
				created: '2026-09-10',
				updated: '2026-09-11',
				status: 'active',
				summary: 'Sample session',
			});
		});

		it('listGrokSessions executes runner and returns parsed summaries', async () => {
			const mockRunner = vi.fn().mockResolvedValue({
				stdout:
					'SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY\n01a08004-0fbb-78a3-b1f3-a54fbfe035c8  2026-09-08  2026-09-08  local  Test Session',
				exitCode: 0,
			});

			const results = await listGrokSessions({
				limit: 10,
				runner: mockRunner,
			});

			expect(mockRunner).toHaveBeenCalledWith({
				file: 'grok',
				args: ['sessions', 'list', '-n', '10'],
				cwd: undefined,
			});
			expect(results).toHaveLength(1);
			expect(results[0]?.id).toBe('01a08004-0fbb-78a3-b1f3-a54fbfe035c8');
			expect(results[0]?.summary).toBe('Test Session');
		});

		it('searchGrokSessions executes runner with keyword query', async () => {
			const mockRunner = vi.fn().mockResolvedValue({
				stdout:
					'SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY\n01a0800b-79ae-7c10-9288-ddb61c848c75  2026-09-08  2026-09-08  local  Match found',
				exitCode: 0,
			});

			const results = await searchGrokSessions('Match', {
				runner: mockRunner,
			});

			expect(mockRunner).toHaveBeenCalledWith({
				file: 'grok',
				args: ['sessions', 'search', 'Match'],
				cwd: undefined,
			});
			expect(results).toHaveLength(1);
			expect(results[0]?.summary).toBe('Match found');
		});

		it('exportGrokSession executes grok export and returns markdown', async () => {
			const sampleMarkdown = '## User\n\n你好\n\n## Assistant\n\n你好。我是 Grok。';
			const mockRunner = vi.fn().mockResolvedValue({
				stdout: sampleMarkdown,
				exitCode: 0,
			});

			const transcript = await exportGrokSession('01a07ff8-0074-7782-8fd6-d0636654f381', {
				runner: mockRunner,
			});

			expect(mockRunner).toHaveBeenCalledWith({
				file: 'grok',
				args: ['export', '01a07ff8-0074-7782-8fd6-d0636654f381'],
				cwd: undefined,
			});
			expect(transcript).toBe(sampleMarkdown);
		});

		it('rejects execution when runner is missing or returns non-zero exit code', async () => {
			await expect(listGrokSessions()).rejects.toThrow();
			await expect(searchGrokSessions('test')).rejects.toThrow();
			await expect(exportGrokSession('id')).rejects.toThrow();
			await expect(exportGrokSession('')).rejects.toThrow();

			const failingRunner = vi.fn().mockResolvedValue({
				stdout: '',
				stderr: 'network failure',
				exitCode: 1,
			});

			await expect(listGrokSessions({ runner: failingRunner })).rejects.toThrow();
			await expect(exportGrokSession('id', { runner: failingRunner })).rejects.toThrow();
		});

		it('AC 2 Architecture assertion: forbids direct SQLite connection in adapters/grok/', () => {
			const grokAdapterDir = join(__dirname, '../../src/adapters/grok');
			const files = readdirSync(grokAdapterDir).filter((f) => f.endsWith('.ts'));
			expect(files.length).toBeGreaterThan(0);

			for (const file of files) {
				const content = readFileSync(join(grokAdapterDir, file), 'utf8');

				// Strictly forbid importing sqlite libraries
				expect(content).not.toMatch(/from\s+['"]better-sqlite3['"]/);
				expect(content).not.toMatch(/from\s+['"]sqlite\d*['"]/);
				expect(content).not.toMatch(/from\s+['"]node:sqlite['"]/);

				// Strictly forbid raw SQL statements
				expect(content).not.toMatch(/\bSELECT\s+.*FROM\b/i);
				expect(content).not.toMatch(/\bINSERT\s+INTO\b/i);
				expect(content).not.toMatch(/\bUPDATE\s+.*SET\b/i);
				expect(content).not.toMatch(/\bDELETE\s+FROM\b/i);

				// Forbid direct SQLite file paths
				expect(content).not.toMatch(/sessions\.db\b/i);
				expect(content).not.toMatch(/\.sqlite\b/i);
			}
		});
	});

	describe('M6-T7 提问与阻断分类归一化 (R1, R2, E-115, E-134)', () => {
		it('marks requiresReply and isQuestion for question tools, leaves normal tools unmarked', () => {
			const questionLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'tc-q-1',
						title: 'ask_user',
						rawInput: { question: 'Should we proceed?' },
					},
				},
			});
			const res = mapGrokEvents(questionLine, { runId: 'run-grok-1' });
			expect(res).toHaveLength(1);
			expect(res[0]?.kind).toBe('tool_call');
			expect((res[0]?.payload as { requiresReply?: boolean })?.requiresReply).toBe(true);
			expect((res[0]?.payload as { isQuestion?: boolean })?.isQuestion).toBe(true);

			const normalLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'tc-norm-1',
						title: 'readFile',
						rawInput: { path: 'package.json' },
					},
				},
			});
			const resNorm = mapGrokEvents(normalLine, { runId: 'run-grok-1' });
			expect(resNorm).toHaveLength(1);
			expect(resNorm[0]?.kind).toBe('tool_call');
			expect((resNorm[0]?.payload as { requiresReply?: boolean })?.requiresReply).toBeUndefined();
			expect((resNorm[0]?.payload as { isQuestion?: boolean })?.isQuestion).toBeUndefined();
		});

		it('normalizes dependency install commands to run.permission_blocked with blockedCategory', () => {
			const npmLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'tc-npm-1',
						title: 'bash',
						rawInput: { command: 'pnpm add axios' },
					},
				},
			});
			const res = mapGrokEvents(npmLine, { runId: 'run-grok-1' });
			expect(res).toHaveLength(1);
			expect(res[0]?.kind).toBe('run.permission_blocked');
			expect((res[0]?.payload as { blockedCategory?: string })?.blockedCategory).toBe(
				'network_dependency',
			);
		});
	});
});
