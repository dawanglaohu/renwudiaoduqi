import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getClaudeCapabilities } from '../../src/adapters/claude/capabilities.ts';
import {
	buildCodexLaunchSpec,
	buildLaunchSpec,
} from '../../src/adapters/codex/build-launch-spec.ts';
import {
	CODEX_NATIVE_CAPABILITIES,
	capabilities,
	getCodexCapabilities,
} from '../../src/adapters/codex/capabilities.ts';
import {
	CODEX_VENDOR_EVENT_STRINGS,
	mapCodexEvents,
	mapEvents,
	parseAndMapCodexLine,
} from '../../src/adapters/codex/map-events.ts';
import { readCodexModels, readModels } from '../../src/adapters/codex/read-models.ts';
import { EFFORT_TIERS } from '../../src/domain/effort-tier.ts';
import { PERMISSION_TIERS } from '../../src/domain/permission-tier.ts';
import { parseWrapupReport } from '../../src/domain/wrapup-report.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const daemonSrc = resolve(__dirname, '../../src');

describe('M4-T8: codex 原生适配器', () => {
	describe('AC 4 & AC 3: 能力位与破坏性变更切 generic-acp (E-186)', () => {
		it('declares canReply=true for native adapter (codex queue --thread --message)', () => {
			expect(capabilities.canReply).toBe(true);
			expect(CODEX_NATIVE_CAPABILITIES.canReply).toBe(true);
			expect(getCodexCapabilities('native').canReply).toBe(true);
		});

		it('declares hasStreamingEvents=true and canResume=true for native adapter', () => {
			expect(CODEX_NATIVE_CAPABILITIES.hasStreamingEvents).toBe(true);
			expect(CODEX_NATIVE_CAPABILITIES.canResume).toBe(true);
			expect(CODEX_NATIVE_CAPABILITIES.sessionHistory).toBe('full');
		});

		it('E-186: switches adapterKind to generic-acp by changing data alone, narrowing capabilities to canReply=false', () => {
			// Simulating changing a single line of configuration in agents.json data:
			// { "adapterKind": "generic-acp" } vs { "adapterKind": "native" }
			const nativeConfig = { adapterKind: 'native' as const };
			const genericAcpConfig = { adapterKind: 'generic-acp' as const };

			const nativeCaps = getCodexCapabilities(nativeConfig.adapterKind);
			expect(nativeCaps.canReply).toBe(true);
			expect(nativeCaps.canResume).toBe(true);

			const acpCaps = getCodexCapabilities(genericAcpConfig.adapterKind);
			// Under generic-acp, capabilities are narrowed and UI greys out reply button
			expect(acpCaps.canReply).toBe(false);
			expect(acpCaps.canResume).toBe(false);
			expect(acpCaps.sessionHistory).toBe('current-run-only');
			// Streaming events remain available
			expect(acpCaps.hasStreamingEvents).toBe(true);
			expect(Object.isFrozen(acpCaps)).toBe(true);
		});

		it('R8-T97041355 E-36: native adapter declares reportsModelRejection=true; generic-acp declares false', () => {
			expect(getCodexCapabilities('native').reportsModelRejection).toBe(true);
			expect(getCodexCapabilities('generic-acp').reportsModelRejection).toBe(false);
			expect(CODEX_NATIVE_CAPABILITIES.reportsModelRejection).toBe(true);
		});
	});

	describe('AC 1 & R2: 主用 app-server，保留 codex exec --json 为退路与权限键映射', () => {
		it('defaults to app-server mode for buildLaunchSpec', () => {
			const spec = buildLaunchSpec({
				runId: 'run-001',
				cwd: '/workspace/project',
			});

			expect(spec.file).toBe('codex');
			expect(spec.cwd).toBe('/workspace/project');
			expect(spec.args[0]).toBe('app-server');
			expect(spec.stdinMode).toBe('pipe');
			expect(spec.args[1]).toBe('--listen');
			expect(spec.args[2]).toBe('stdio://');
			expect(spec.isAcp).toBeUndefined();
			expect(Object.isFrozen(spec)).toBe(true);
			expect(Object.isFrozen(spec.args)).toBe(true);
		});

		it('R2: maps three permission tiers to sandbox_mode in app-server mode and never outputs sandbox=', () => {
			const tiers = [
				{ tier: PERMISSION_TIERS.READ_ONLY, expected: 'sandbox_mode="read-only"' },
				{
					tier: PERMISSION_TIERS.WORKSPACE_WRITE,
					expected: 'sandbox_mode="workspace-write"',
				},
				{
					tier: PERMISSION_TIERS.UNRESTRICTED,
					expected: 'sandbox_mode="danger-full-access"',
				},
			] as const;

			for (const { tier, expected } of tiers) {
				const spec = buildCodexLaunchSpec({
					runId: 'run-sandbox-tier',
					cwd: '/workspace/project',
					permissionTier: tier,
				});

				expect(spec.args).toContain('-c');
				expect(spec.args).toContain(expected);
				// Must NOT contain sandbox=
				for (const arg of spec.args) {
					expect(arg).not.toMatch(/^sandbox=/);
					expect(arg).not.toMatch(/^sandbox="/);
				}
			}
		});

		it('configures model and effort tier in app-server mode', () => {
			const spec = buildCodexLaunchSpec({
				runId: 'run-002',
				cwd: '/workspace/project',
				model: 'o3-mini',
				effortTier: EFFORT_TIERS.HIGH,
				permissionTier: PERMISSION_TIERS.WORKSPACE_WRITE,
			});

			expect(spec.args).toContain('app-server');
			expect(spec.args).toContain('--listen');
			expect(spec.args).toContain('stdio://');
			expect(spec.args).toContain('-c');
			expect(spec.args).toContain('model="o3-mini"');
			expect(spec.args).toContain('model_reasoning_effort="high"');
			expect(spec.args).toContain('sandbox_mode="workspace-write"');
		});

		it('R2: retains --sandbox <value> in exec fallback mode', () => {
			const tiers = [
				{ tier: PERMISSION_TIERS.READ_ONLY, expected: 'read-only' },
				{ tier: PERMISSION_TIERS.WORKSPACE_WRITE, expected: 'workspace-write' },
				{ tier: PERMISSION_TIERS.UNRESTRICTED, expected: 'danger-full-access' },
			] as const;

			for (const { tier, expected } of tiers) {
				const spec = buildCodexLaunchSpec({
					runId: 'run-003',
					cwd: '/workspace/project',
					mode: 'exec',
					permissionTier: tier,
				});

				expect(spec.args[0]).toBe('exec');
				expect(spec.args[1]).toBe('--json');
				expect(spec.args).toContain('--sandbox');
				const sandboxIndex = spec.args.indexOf('--sandbox');
				expect(spec.args[sandboxIndex + 1]).toBe(expected);
			}
		});

		it('supports exec --json fallback mode with model, effort tier, and prompt', () => {
			const spec = buildCodexLaunchSpec({
				runId: 'run-003-full',
				cwd: '/workspace/project',
				mode: 'exec',
				model: 'o3-mini',
				effortTier: EFFORT_TIERS.HIGH,
				permissionTier: PERMISSION_TIERS.WORKSPACE_WRITE,
				prompt: 'Fix the bug in parser.ts',
			});

			expect(spec.args[0]).toBe('exec');
			expect(spec.stdinMode).toBe('closed');
			expect(spec.args[1]).toBe('--json');
			expect(spec.args).toContain('--model');
			expect(spec.args).toContain('o3-mini');
			expect(spec.args).toContain('--sandbox');
			expect(spec.args).toContain('workspace-write');
			expect(spec.args).toContain('model_reasoning_effort="high"');
			expect(spec.args).toContain('Fix the bug in parser.ts');
		});

		it('detects exec mode from customArgs if specified in template', () => {
			const spec = buildLaunchSpec({
				runId: 'run-004',
				cwd: '/workspace/project',
				customArgs: ['exec', '--json'],
			});

			expect(spec.args[0]).toBe('exec');
			expect(spec.args[1]).toBe('--json');
		});

		it('E-112: resumes an ended session with `exec resume <SESSION_ID> <PROMPT>` (prompt in argv)', () => {
			const spec = buildCodexLaunchSpec({
				runId: 'run-resume-1',
				cwd: '/workspace/project',
				mode: 'exec',
				model: 'o3-mini',
				prompt: '- R1: 修好 parser.ts',
				resumeSessionRef: 'thread-abc-123',
			});

			expect(spec.args[0]).toBe('exec');
			expect(spec.args).toContain('resume');
			expect(spec.args.indexOf('resume')).toBeLessThan(spec.args.indexOf('thread-abc-123'));
			expect(spec.args.indexOf('thread-abc-123')).toBeLessThan(
				spec.args.indexOf('- R1: 修好 parser.ts'),
			);
		});

		it('E-112: refuses to fake a resume on app-server mode instead of silently starting a new session', () => {
			expect(() =>
				buildCodexLaunchSpec({
					runId: 'run-resume-2',
					cwd: '/workspace/project',
					prompt: '- R1: 修好 parser.ts',
					resumeSessionRef: 'thread-abc-123',
				}),
			).toThrowError(/resume/i);
		});

		it('marks isAcp=true when adapterKind is generic-acp', () => {
			const spec = buildLaunchSpec({
				runId: 'run-005',
				cwd: '/workspace/project',
				adapterKind: 'generic-acp',
			});

			expect(spec.isAcp).toBe(true);
		});
	});

	describe('AC 1 & R1: map-events 产出同一套归一化事件 (app-server 与 real snake_case exec --json)', () => {
		const context = { runId: 'run-test-1', taskId: 'M4-T8' };

		it('maps message chunks identically from app-server and exec --json', () => {
			// app-server line
			const appServerLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'item/agentMessage/delta',
				params: {
					threadId: 'th-1',
					turnId: 'tu-1',
					itemId: 'msg-1',
					delta: 'Generating solution...',
				},
			});

			// real exec --json line with snake_case item.started
			const execLine = JSON.stringify({
				type: 'item.started',
				item: {
					type: 'agent_message',
					id: 'msg-1',
					text: 'Generating solution...',
				},
			});

			const appServerEvents = mapEvents(appServerLine, context);
			const execEvents = mapEvents(execLine, context);

			expect(appServerEvents.length).toBe(1);
			expect(execEvents.length).toBe(1);

			const ev1 = appServerEvents[0];
			const ev2 = execEvents[0];

			expect(ev1?.kind).toBe('agent_message_chunk');
			expect(ev2?.kind).toBe('agent_message_chunk');
			expect(ev1?.payload.chunk).toBe('Generating solution...');
			expect(ev2?.payload.chunk).toBe('Generating solution...');
			expect(ev1?.runId).toBe('run-test-1');
			expect(ev2?.runId).toBe('run-test-1');
		});

		it('maps a completed exec agent message so wrapup reports reach the parser', () => {
			const report =
				'BATCH_SUMMARY\nDone\nTESTS\npass\nBUGS\nnone\nFIXED\nnone\nNOT_FIXED\nnone\nSUSPECT\nnone\nRECORD\nverdict: clean\nNEXT\nDone';
			const preface = mapCodexEvents(
				JSON.stringify({
					type: 'item.completed',
					item: { id: 'msg-preface', type: 'agent_message', text: 'Tests passed.' },
				}),
				context,
			);
			const result = parseAndMapCodexLine(
				JSON.stringify({
					type: 'item.completed',
					item: { id: 'msg-final', type: 'agent_message', text: report },
				}),
				context,
			);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]).toMatchObject({
				kind: 'agent_message_chunk',
				payload: { chunk: `${report}\n` },
				runId: 'run-test-1',
			});
			const text = `${preface[0]?.payload.chunk}${result.events[0]?.payload.chunk}`;
			expect(text).toContain('Tests passed.\nBATCH_SUMMARY\n');
			expect(parseWrapupReport(text).ok).toBe(true);
			expect(result.unmappedCount).toBe(0);
		});

		it('maps reasoning/thought chunks identically from app-server and exec --json', () => {
			const appServerLine = JSON.stringify({
				method: 'item/reasoning/textDelta',
				params: {
					delta: 'Analyzing type constraints...',
					itemId: 'rs-1',
				},
			});

			const execLine = JSON.stringify({
				type: 'item.reasoning.delta',
				delta: 'Analyzing type constraints...',
				itemId: 'rs-1',
			});

			const ev1 = mapCodexEvents(appServerLine, context)[0];
			const ev2 = mapCodexEvents(execLine, context)[0];

			expect(ev1?.kind).toBe('agent_thought_chunk');
			expect(ev2?.kind).toBe('agent_thought_chunk');
			expect(ev1?.payload.chunk).toBe('Analyzing type constraints...');
			expect(ev2?.payload.chunk).toBe('Analyzing type constraints...');
		});

		it('R1: maps a real exec reasoning item to agent_thought_chunk (item.type = reasoning)', () => {
			// exec --json delivers the thought as a completed item instead of a delta event.
			const execLine = JSON.stringify({
				type: 'item.completed',
				item: {
					id: 'rs-2',
					type: 'reasoning',
					text: 'Checking the schema against the installed CLI.',
				},
			});

			const result = parseAndMapCodexLine(execLine, context);
			expect(result.events.length).toBe(1);
			expect(result.events[0]?.kind).toBe('agent_thought_chunk');
			expect(result.events[0]?.payload.chunk).toBe(
				'Checking the schema against the installed CLI.',
			);
			expect(result.unmappedCount).toBe(0);
		});

		it('maps command execution tool_call started identically using camelCase (app-server) and real snake_case (exec)', () => {
			// app-server uses commandExecution
			const appServerItem = {
				type: 'commandExecution',
				id: 'cmd-42',
				command: 'pnpm test',
				cwd: '/app/repo',
			};

			// real exec uses command_execution
			const execItem = {
				type: 'command_execution',
				id: 'cmd-42',
				command: 'pnpm test',
				cwd: '/app/repo',
			};

			const appServerLine = JSON.stringify({
				method: 'item/started',
				params: { item: appServerItem },
			});

			const execLine = JSON.stringify({
				type: 'item.started',
				item: execItem,
			});

			const ev1 = mapEvents(appServerLine, context)[0];
			const ev2 = mapEvents(execLine, context)[0];

			expect(ev1?.kind).toBe('tool_call');
			expect(ev2?.kind).toBe('tool_call');
			expect(ev1?.payload.callId).toBe('cmd-42');
			expect(ev2?.payload.callId).toBe('cmd-42');
			expect(ev1?.payload.tool).toBe('commandExecution');
			expect(ev2?.payload.tool).toBe('commandExecution');
			expect(ev1?.payload.input).toEqual({ command: 'pnpm test', cwd: '/app/repo' });
			expect(ev2?.payload.input).toEqual({ command: 'pnpm test', cwd: '/app/repo' });
		});

		it('maps command execution completed identically using camelCase (app-server) and real snake_case exit_code / aggregated_output (exec)', () => {
			const appServerItem = {
				type: 'commandExecution',
				id: 'cmd-42',
				command: 'pnpm test',
				exitCode: 0,
				aggregatedOutput: '✓ 12 tests passed',
				status: 'completed',
				durationMs: 450,
			};

			const execItem = {
				type: 'command_execution',
				id: 'cmd-42',
				command: 'pnpm test',
				exit_code: 0,
				aggregated_output: '✓ 12 tests passed',
				status: 'completed',
				duration_ms: 450,
			};

			const appServerLine = JSON.stringify({
				method: 'item/completed',
				params: { item: appServerItem },
			});

			const execLine = JSON.stringify({
				type: 'item.completed',
				item: execItem,
			});

			const ev1 = mapEvents(appServerLine, context)[0];
			const ev2 = mapEvents(execLine, context)[0];

			expect(ev1?.kind).toBe('tool_call_update');
			expect(ev2?.kind).toBe('tool_call_update');
			expect(ev1?.payload.callId).toBe('cmd-42');
			expect(ev2?.payload.callId).toBe('cmd-42');
			expect(ev1?.payload.output).toEqual({
				exitCode: 0,
				aggregatedOutput: '✓ 12 tests passed',
				status: 'completed',
				durationMs: 450,
			});
			expect(ev2?.payload.output).toEqual({
				exitCode: 0,
				aggregatedOutput: '✓ 12 tests passed',
				status: 'completed',
				durationMs: 450,
			});
		});

		it('R1: 同一命令在两条通道产出同样事件 (end-to-end command lifecycle test)', () => {
			const command = 'git status --short';
			const cwd = '/workspace/project';
			const output = 'M packages/daemon/src/adapters/codex/map-events.ts';

			// App-server events
			const appServerStart = JSON.stringify({
				jsonrpc: '2.0',
				method: 'item/started',
				params: {
					item: {
						type: 'commandExecution',
						id: 'call-unified-1',
						command,
						cwd,
					},
				},
			});
			const appServerDone = JSON.stringify({
				jsonrpc: '2.0',
				method: 'item/completed',
				params: {
					item: {
						type: 'commandExecution',
						id: 'call-unified-1',
						command,
						exitCode: 0,
						aggregatedOutput: output,
						status: 'completed',
						durationMs: 120,
					},
				},
			});

			// Real exec events (snake_case types and fields)
			const execStart = JSON.stringify({
				type: 'item.started',
				item: {
					type: 'command_execution',
					id: 'call-unified-1',
					command,
					cwd,
				},
			});
			const execDone = JSON.stringify({
				type: 'item.completed',
				item: {
					type: 'command_execution',
					id: 'call-unified-1',
					command,
					exit_code: 0,
					aggregated_output: output,
					status: 'completed',
					duration_ms: 120,
				},
			});

			const appEvents = [
				...mapEvents(appServerStart, context),
				...mapEvents(appServerDone, context),
			];
			const execEvents = [...mapEvents(execStart, context), ...mapEvents(execDone, context)];

			expect(appEvents.length).toBe(2);
			expect(execEvents.length).toBe(2);

			// Check event 1 (tool_call)
			expect(appEvents[0]?.kind).toBe('tool_call');
			expect(execEvents[0]?.kind).toBe('tool_call');
			expect(appEvents[0]?.payload.callId).toBe('call-unified-1');
			expect(execEvents[0]?.payload.callId).toBe('call-unified-1');
			expect(appEvents[0]?.payload.input).toEqual({ command, cwd });
			expect(execEvents[0]?.payload.input).toEqual({ command, cwd });

			// Check event 2 (tool_call_update)
			expect(appEvents[1]?.kind).toBe('tool_call_update');
			expect(execEvents[1]?.kind).toBe('tool_call_update');
			expect(appEvents[1]?.payload.callId).toBe('call-unified-1');
			expect(execEvents[1]?.payload.callId).toBe('call-unified-1');
			expect(appEvents[1]?.payload.output).toEqual({
				exitCode: 0,
				aggregatedOutput: output,
				status: 'completed',
				durationMs: 120,
			});
			expect(execEvents[1]?.payload.output).toEqual({
				exitCode: 0,
				aggregatedOutput: output,
				status: 'completed',
				durationMs: 120,
			});
		});

		it('detects git push and emits run.remote_push_detected in addition to tool_call_update', () => {
			const pushItem = {
				type: 'commandExecution',
				id: 'cmd-push',
				command: 'git push origin task/M4-T8',
				exitCode: 0,
				aggregatedOutput: 'To github.com:owner/repo.git\n * [new branch] task/M4-T8 -> task/M4-T8',
				status: 'completed',
			};

			const events = mapEvents(
				JSON.stringify({ method: 'item/completed', params: { item: pushItem } }),
				context,
			);
			expect(events.length).toBe(2);
			expect(events[0]?.kind).toBe('tool_call_update');
			expect(events[1]?.kind).toBe('run.remote_push_detected');
		});

		it('maps fileChange / file_change tool_call and update for both channels', () => {
			const startLine = JSON.stringify({
				method: 'item/started',
				params: {
					item: {
						type: 'fileChange',
						id: 'fc-1',
						changes: [{ path: 'src/main.ts', kind: 'modify' }],
					},
				},
			});

			const execCompleteLine = JSON.stringify({
				type: 'item.completed',
				item: {
					type: 'file_change',
					id: 'fc-1',
					status: 'applied',
					changes: [{ path: 'src/main.ts', kind: 'modify' }],
				},
			});

			const startEv = mapEvents(startLine)[0];
			expect(startEv?.kind).toBe('tool_call');
			expect(startEv?.payload.tool).toBe('fileChange');
			expect(startEv?.payload.callId).toBe('fc-1');

			const completeEv = mapEvents(execCompleteLine)[0];
			expect(completeEv?.kind).toBe('tool_call_update');
			expect(completeEv?.payload.callId).toBe('fc-1');
			expect(completeEv?.payload.output).toEqual({
				status: 'applied',
				changes: [{ path: 'src/main.ts', kind: 'modify' }],
			});
		});

		it('maps plans identically from app-server and exec --json', () => {
			const appServerLine = JSON.stringify({
				method: 'turn/plan/updated',
				params: {
					plan: [
						{ step: 1, text: 'Run tests' },
						{ step: 2, text: 'Commit changes' },
					],
				},
			});

			const execLine = JSON.stringify({
				type: 'turn.plan.updated',
				plan: [
					{ step: 1, text: 'Run tests' },
					{ step: 2, text: 'Commit changes' },
				],
			});

			const ev1 = mapEvents(appServerLine)[0];
			const ev2 = mapEvents(execLine)[0];

			expect(ev1?.kind).toBe('plan');
			expect(ev2?.kind).toBe('plan');
			expect(ev1?.payload.entries).toEqual(ev2?.payload.entries);
		});

		describe('R3: turn/completed status handling (completed, failed, interrupted)', () => {
			it('handles completed turn: emits run.exited with exitCode=0', () => {
				const line = JSON.stringify({
					method: 'turn/completed',
					params: {
						threadId: 'th-1',
						turn: {
							id: 'turn-1',
							status: 'completed',
						},
					},
				});

				const events = mapEvents(line, context);
				expect(events.length).toBe(1);
				expect(events[0]?.kind).toBe('run.exited');
				expect(events[0]?.payload.exitCode).toBe(0);
			});

			it('handles failed turn: emits run.stderr_line and run.exited with exitCode=1 (failed 不得是 0)', () => {
				const line = JSON.stringify({
					method: 'turn/completed',
					params: {
						threadId: 'th-1',
						turn: {
							id: 'turn-2',
							status: 'failed',
							error: {
								message: 'Context window token limit exceeded',
							},
						},
					},
				});

				const events = mapEvents(line, context);
				expect(events.length).toBe(2);
				expect(events[0]?.kind).toBe('run.stderr_line');
				expect(events[0]?.payload.line).toBe('Context window token limit exceeded');
				expect(events[1]?.kind).toBe('run.exited');
				expect(events[1]?.payload.exitCode).toBe(1);
				expect(events[1]?.payload.exitCode).not.toBe(0);
			});

			it('handles interrupted turn: emits run.exited with exitCode=130 and signal=SIGINT', () => {
				const line = JSON.stringify({
					method: 'turn/completed',
					params: {
						threadId: 'th-1',
						turn: {
							id: 'turn-3',
							status: 'interrupted',
						},
					},
				});

				const events = mapEvents(line, context);
				expect(events.length).toBe(1);
				expect(events[0]?.kind).toBe('run.exited');
				expect(events[0]?.payload.exitCode).toBe(130);
				expect(events[0]?.payload.signal).toBe('SIGINT');
			});

			it('handles turn.failed in exec mode: exitCode=1', () => {
				const line = JSON.stringify({
					type: 'turn.failed',
					error: 'Command failed with exit code 2',
				});

				const events = mapEvents(line, context);
				expect(events.length).toBe(2);
				expect(events[0]?.kind).toBe('run.stderr_line');
				expect(events[0]?.payload.line).toBe('Command failed with exit code 2');
				expect(events[1]?.kind).toBe('run.exited');
				expect(events[1]?.payload.exitCode).toBe(1);
			});
		});

		describe('R4: 未知 item 类型与 item.updated 处理与计数', () => {
			it('counts unmappedCount=1 when item.started has an unknown item type', () => {
				const line = JSON.stringify({
					method: 'item/started',
					params: {
						item: {
							type: 'unknown_vendor_feature_2026',
							id: 'feat-1',
						},
					},
				});

				const result = parseAndMapCodexLine(line);
				expect(result.events.length).toBe(0);
				expect(result.unmappedCount).toBe(1);
			});

			it('counts unmappedCount=0 when item.started has a known item type', () => {
				const line = JSON.stringify({
					method: 'item/started',
					params: {
						item: {
							type: 'commandExecution',
							id: 'feat-2',
							command: 'ls',
						},
					},
				});

				const result = parseAndMapCodexLine(line);
				expect(result.events.length).toBe(1);
				expect(result.unmappedCount).toBe(0);
			});

			it('counts unmappedCount=1 when item.completed has an unknown item type', () => {
				const line = JSON.stringify({
					type: 'item.completed',
					item: {
						type: 'unknown_future_item',
						id: 'feat-3',
					},
				});

				const result = parseAndMapCodexLine(line);
				expect(result.events.length).toBe(0);
				expect(result.unmappedCount).toBe(1);
			});

			it('handles item.updated: maps known command_execution and counts unknown type as 1', () => {
				// Known item type in item.updated
				const knownLine = JSON.stringify({
					type: 'item.updated',
					item: {
						type: 'command_execution',
						id: 'cmd-up',
						aggregated_output: 'Streaming delta output...',
						status: 'running',
					},
				});

				const knownResult = parseAndMapCodexLine(knownLine);
				expect(knownResult.events.length).toBe(1);
				expect(knownResult.events[0]?.kind).toBe('tool_call_update');
				expect(knownResult.events[0]?.payload.callId).toBe('cmd-up');
				expect(knownResult.unmappedCount).toBe(0);

				// Unknown item type in item.updated
				const unknownLine = JSON.stringify({
					type: 'item.updated',
					item: {
						type: 'unknown_update_type',
						id: 'up-1',
					},
				});

				const unknownResult = parseAndMapCodexLine(unknownLine);
				expect(unknownResult.events.length).toBe(0);
				expect(unknownResult.unmappedCount).toBe(1);
			});

			it('maps real exec error item to run.stderr_line with unmappedCount=0', () => {
				const line = JSON.stringify({
					type: 'item.started',
					item: {
						type: 'error',
						id: 'err-item-1',
						message: 'Command execution timed out after 30s',
					},
				});

				const result = parseAndMapCodexLine(line);
				expect(result.events.length).toBe(1);
				expect(result.events[0]?.kind).toBe('run.stderr_line');
				expect(result.events[0]?.payload.line).toBe('Command execution timed out after 30s');
				expect(result.unmappedCount).toBe(0);
			});
		});

		it('maps run lifecycle events (started, permission_blocked, error)', () => {
			const startEvents = mapEvents(
				JSON.stringify({ method: 'turn/started', params: { turnId: 't1' } }),
				context,
			);
			expect(startEvents[0]?.kind).toBe('run.started');

			const errorEvents = mapEvents(
				JSON.stringify({
					method: 'error',
					params: { message: 'Token limit exceeded' },
				}),
			);
			expect(errorEvents[0]?.kind).toBe('run.stderr_line');
			expect(errorEvents[0]?.payload.line).toBe('Token limit exceeded');

			const permEvents = mapEvents(
				JSON.stringify({
					method: 'item/autoApprovalReview/started',
					params: { message: 'Write to /etc denied' },
				}),
			);
			expect(permEvents[0]?.kind).toBe('run.permission_blocked');
			expect(permEvents[0]?.payload.reason).toBe('Write to /etc denied');
		});

		it('gracefully handles unparseable lines and unknown types without crashing or inventing kinds', () => {
			// Unparseable non-JSON line
			const unparseable = parseAndMapCodexLine('this is raw stdout text from some child');
			expect(unparseable.parseError).toBe(true);
			expect(unparseable.events).toEqual([]);

			// Valid JSON with completely unknown vendor event
			const unknownType = parseAndMapCodexLine(
				JSON.stringify({
					method: 'unknown/vendor/event_2026',
					params: { foo: 'bar' },
				}),
			);
			expect(unknownType.unmappedCount).toBe(1);
			expect(unknownType.events).toEqual([]);
		});

		it('R8-T97041355 AC 2 & E-36: turn/failed with structured error code/type emits exactly one run.model_rejected', () => {
			const structuredLine = JSON.stringify({
				method: 'turn/failed',
				params: {
					turn: {
						model: 'gpt-fake-model',
						error: {
							code: 'model_not_found',
							message: 'The model gpt-fake-model does not exist',
						},
					},
				},
			});

			const result = parseAndMapCodexLine(structuredLine, context);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.kind).toBe('run.model_rejected');
			expect(result.events[0]?.payload).toMatchObject({
				code: 'model_invalid',
				modelName: 'gpt-fake-model',
				vendorMessage: 'The model gpt-fake-model does not exist',
			});
			expect(result.unmappedCount).toBe(0);
		});

		it('R8-T97041355 AC 2 & E-36: turn/failed with identical message in free text/stderr does NOT emit run.model_rejected', () => {
			const freeTextLine = JSON.stringify({
				method: 'turn/failed',
				params: {
					message: 'The model gpt-fake-model does not exist',
				},
			});

			const result = parseAndMapCodexLine(freeTextLine, context);
			expect(result.events.some((e) => e.kind === 'run.model_rejected')).toBe(false);
			expect(result.events.some((e) => e.kind === 'run.stderr_line')).toBe(true);
			expect(result.events.some((e) => e.kind === 'run.exited')).toBe(true);
		});

		it('R8-T97041355 AC 2: claude capabilities declares reportsModelRejection=false', () => {
			expect(getClaudeCapabilities().reportsModelRejection).toBe(false);
		});
	});

	describe('AC 2 & R5: 厂商事件字符串只出现在本目录，service/jobs/http 中出现即架构测试失败', () => {
		it('R5: CODEX_VENDOR_EVENT_STRINGS covers all case literals in map-events.ts minus generic whitelist', () => {
			const mapEventsSource = readFileSync(join(daemonSrc, 'adapters/codex/map-events.ts'), 'utf8');
			const caseRegex = /case\s+['"]([^'"]+)['"]/g;
			const casesInFile = new Set<string>();

			let match: RegExpExecArray | null = caseRegex.exec(mapEventsSource);
			while (match !== null) {
				if (match[1] !== undefined) {
					casesInFile.add(match[1]);
				}
				match = caseRegex.exec(mapEventsSource);
			}

			// Generic names not considered vendor-specific per R5 instructions
			const GENERIC_WHITELIST = new Set([
				'plan',
				'agent_message_chunk',
				'agent_thought_chunk',
				'error',
			]);

			const nonGenericCases = Array.from(casesInFile).filter((c) => !GENERIC_WHITELIST.has(c));
			expect(nonGenericCases.length).toBeGreaterThan(20);

			for (const caseStr of nonGenericCases) {
				expect(
					CODEX_VENDOR_EVENT_STRINGS,
					`Expected CODEX_VENDOR_EVENT_STRINGS to cover case literal "${caseStr}" from map-events.ts`,
				).toContain(caseStr);
			}
		});

		it('asserts vendor event strings do not appear in service, jobs, or http layers', () => {
			const targetDirectories = ['service', 'jobs', 'http'];
			const violations: { file: string; match: string }[] = [];

			for (const dirName of targetDirectories) {
				const fullDirPath = join(daemonSrc, dirName);
				const files = collectTypeScriptFiles(fullDirPath);

				for (const filePath of files) {
					const content = readFileSync(filePath, 'utf8');
					for (const vendorString of CODEX_VENDOR_EVENT_STRINGS) {
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

	describe('readModels integration', () => {
		it('exports readModels and readCodexModels from codex adapter', () => {
			expect(typeof readModels).toBe('function');
			expect(typeof readCodexModels).toBe('function');
		});
	});

	describe('M6-T7 提问与阻断分类归一化 (R1, R2, E-115, E-134)', () => {
		it('marks requiresReply and isQuestion for question tools, leaves normal tools unmarked', () => {
			const questionLine = JSON.stringify({
				type: 'item.started',
				item: {
					id: 'mcp-q-1',
					type: 'mcpToolCall',
					tool: 'ask_user',
					arguments: { question: 'Approve this change?' },
				},
			});
			const res = mapCodexEvents(questionLine, { runId: 'run-codex-1' });
			expect(res).toHaveLength(1);
			expect(res[0]?.kind).toBe('tool_call');
			expect((res[0]?.payload as { requiresReply?: boolean })?.requiresReply).toBe(true);
			expect((res[0]?.payload as { isQuestion?: boolean })?.isQuestion).toBe(true);

			const normalLine = JSON.stringify({
				type: 'item.started',
				item: {
					id: 'mcp-norm-1',
					type: 'mcpToolCall',
					tool: 'readFile',
					arguments: { path: 'src/main.ts' },
				},
			});
			const resNorm = mapCodexEvents(normalLine, { runId: 'run-codex-1' });
			expect(resNorm).toHaveLength(1);
			expect(resNorm[0]?.kind).toBe('tool_call');
			expect((resNorm[0]?.payload as { requiresReply?: boolean })?.requiresReply).toBeUndefined();
			expect((resNorm[0]?.payload as { isQuestion?: boolean })?.isQuestion).toBeUndefined();
		});

		it('normalizes dependency install commands to run.permission_blocked with blockedCategory', () => {
			const npmLine = JSON.stringify({
				type: 'item.started',
				item: {
					id: 'cmd-1',
					type: 'commandExecution',
					command: 'npm i --save lodash',
				},
			});
			const res = mapCodexEvents(npmLine, { runId: 'run-codex-1' });
			expect(res).toHaveLength(1);
			expect(res[0]?.kind).toBe('run.permission_blocked');
			expect((res[0]?.payload as { blockedCategory?: string })?.blockedCategory).toBe(
				'network_dependency',
			);
		});
	});
});

function collectTypeScriptFiles(dir: string): string[] {
	const results: string[] = [];
	let entries: import('node:fs').Dirent[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTypeScriptFiles(fullPath));
		} else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.endsWith('.test.ts')) {
			results.push(fullPath);
		}
	}
	return results;
}
