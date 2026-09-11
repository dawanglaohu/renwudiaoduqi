import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildPiLaunchSpec } from '../../src/adapters/pi/build-launch-spec.ts';
import { getPiCapabilities } from '../../src/adapters/pi/capabilities.ts';
import { createPiRpcClient } from '../../src/adapters/pi/client.ts';
import {
	createPiEventTracker,
	isKnownPiEventType,
	mapPiEvents,
} from '../../src/adapters/pi/map-events.ts';
import { createLineReader } from '../../src/proc/line-reader.ts';

describe('M4-T10: pi 原生适配器（RPC 模式）', () => {
	describe('1) 走 --mode rpc，用 pi 自带的官方客户端导出而非第三方 ACP 桥接 (AC 1)', () => {
		it('buildPiLaunchSpec guarantees --mode rpc in arguments', () => {
			const spec = buildPiLaunchSpec({
				runId: 'run-pi-1',
				cwd: '/workspace/test',
			});

			expect(spec.file).toBe('pi');
			expect(spec.args).toContain('--mode');
			const modeIdx = spec.args.indexOf('--mode');
			expect(spec.args[modeIdx + 1]).toBe('rpc');
			expect(spec.isAcp).toBe(false);
		});

		it('replaces non-rpc mode with rpc if template specified another mode', () => {
			const spec = buildPiLaunchSpec({
				runId: 'run-pi-2',
				cwd: '/workspace/test',
				argsTemplate: ['--print', '--mode', 'json', '--model', '{model}'],
				model: 'anthropic/claude-3-5-sonnet',
			});

			expect(spec.args).toContain('--mode');
			const modeIdx = spec.args.indexOf('--mode');
			expect(spec.args[modeIdx + 1]).toBe('rpc');
			expect(spec.args).not.toContain('json');
			expect(spec.args).toContain('anthropic/claude-3-5-sonnet');
		});

		it('respects session-dir and no-session options', () => {
			const spec = buildPiLaunchSpec({
				runId: 'run-pi-3',
				cwd: '/workspace/test',
				sessionDir: '/data/sessions',
				noSession: true,
			});

			expect(spec.args).toContain('--session-dir');
			const sessionDirIdx = spec.args.indexOf('--session-dir');
			expect(spec.args[sessionDirIdx + 1]).toBe('/data/sessions');
			expect(spec.args).toContain('--no-session');
		});

		it('maps permission tier and effort tier to pi arguments', () => {
			const spec = buildPiLaunchSpec({
				runId: 'run-pi-4',
				cwd: '/workspace/test',
				permissionTier: 'readOnly',
				effortTier: 'high',
			});

			expect(spec.args).toContain('--tools');
			expect(spec.args).toContain('read,grep,find,ls');
			expect(spec.args).toContain('--thinking');
			expect(spec.args).toContain('high');
		});

		it('declares RPC mode capabilities and does not claim ACP bridging', () => {
			const caps = getPiCapabilities();
			expect(caps.mode).toBe('rpc');
			expect(caps.inputFormat).toBe('rpc');
			expect(caps.outputFormat).toBe('rpc');
			expect(caps.canReply).toBe(true);
			expect(caps.hasStreamingEvents).toBe(true);
			expect(caps.supportedCommands).toEqual(['prompt', 'steer', 'abort', 'get_state']);
			expect(caps.completionEvent).toBe('agent_settled');
		});
	});

	describe('2) 禁用 Node readline，用 M1-T7 的行读取器；配含 U+2028 输出的回归用例 (AC 2 & E-203)', () => {
		it('forbids Node readline imports in adapters/pi source files', () => {
			const piDir = join(__dirname, '../../src/adapters/pi');
			const files = [
				'build-launch-spec.ts',
				'capabilities.ts',
				'client.ts',
				'map-events.ts',
				'read-models.ts',
			];
			for (const file of files) {
				const content = readFileSync(join(piDir, file), 'utf8');
				expect(content).not.toMatch(/from ['"](?:node:)?readline['"]/);
				expect(content).not.toMatch(/require\(['"](?:node:)?readline['"]\)/);
			}
		});

		it('M1-T7 line reader strictly slices on 0x0A, strips trailing \\r, and preserves U+2028 without line breaking (E-203)', () => {
			const u2028Char = '\u2028';
			const u2029Char = '\u2029';
			const rawPayload = {
				type: 'message_update',
				assistantMessageEvent: {
					type: 'text_delta',
					delta: `Prefix${u2028Char}Middle${u2029Char}Suffix`,
				},
			};
			const jsonLine = JSON.stringify(rawPayload);
			const buffer = Buffer.from(`${jsonLine}\r\n`, 'utf8');

			const reader = createLineReader();
			const readLines = reader.push(buffer);

			expect(readLines.length).toBe(1);
			const lineText = readLines[0]?.text ?? '';
			expect(lineText).toBe(jsonLine);
			expect(lineText).toContain(u2028Char);
			expect(lineText).toContain(u2029Char);

			const parsed = JSON.parse(lineText);
			expect(parsed.assistantMessageEvent.delta).toBe(`Prefix${u2028Char}Middle${u2029Char}Suffix`);
		});

		it('PiRpcClient correctly processes stdout chunk with U+2028 via M1-T7 reader (E-203 regression)', async () => {
			const writtenLines: string[] = [];
			const client = createPiRpcClient({
				transport: {
					writeStdin(data: string | Buffer) {
						writtenLines.push(String(data));
						return true;
					},
				},
				runId: 'run-e203',
			});

			const envelopesReceived: unknown[] = [];
			client.onEnvelope((env) => {
				envelopesReceived.push(env);
			});

			// Feed a chunk containing U+2028 inside a text_delta JSON line
			const u2028 = '\u2028';
			const jsonChunk = Buffer.from(
				`${JSON.stringify({
					type: 'message_update',
					assistantMessageEvent: {
						type: 'text_delta',
						delta: `First line${u2028}Second line`,
					},
				})}\n`,
				'utf8',
			);

			const lines = client.pushChunk(jsonChunk);
			expect(lines.length).toBe(1);
			expect(envelopesReceived.length).toBe(1);

			const envelope = envelopesReceived[0] as {
				kind: string;
				payload: { chunk: string };
			};
			expect(envelope.kind).toBe('agent_message_chunk');
			expect(envelope.payload.chunk).toBe(`First line${u2028}Second line`);

			client.dispose();
		});

		it('PiRpcClient processes U+2028 split across buffer chunk boundaries', async () => {
			const client = createPiRpcClient({ runId: 'run-chunk-e203' });
			const envelopesReceived: unknown[] = [];
			client.onEnvelope((env) => envelopesReceived.push(env));

			const u2028 = '\u2028';
			const fullPayload = `${JSON.stringify({
				type: 'message_update',
				assistantMessageEvent: {
					type: 'text_delta',
					delta: `Code before${u2028}Code after`,
				},
			})}\n`;

			const fullBuf = Buffer.from(fullPayload, 'utf8');
			// Cut right in the middle
			const mid = Math.floor(fullBuf.length / 2);
			const chunk1 = fullBuf.subarray(0, mid);
			const chunk2 = fullBuf.subarray(mid);

			client.pushChunk(chunk1);
			expect(envelopesReceived.length).toBe(0); // Not completed yet

			client.pushChunk(chunk2);
			expect(envelopesReceived.length).toBe(1); // Complete line assembled!

			const envelope = envelopesReceived[0] as {
				kind: string;
				payload: { chunk: string };
			};
			expect(envelope.payload.chunk).toBe(`Code before${u2028}Code after`);

			client.dispose();
		});
	});

	describe('3) 只依赖已验证的最小命令子集与 agent_settled，大版本升级未知事件忽略并计数 (AC 3 & E-202)', () => {
		it('supports prompt command with correlation ID and response handling', async () => {
			let sentData = '';
			const client = createPiRpcClient({
				transport: {
					writeStdin(data: string | Buffer) {
						sentData = String(data);
						return true;
					},
				},
				requestTimeoutMs: 1000,
			});

			const promptPromise = client.prompt('Implement feature X');

			// Check sent command format
			const sentObj = JSON.parse(sentData.trim());
			expect(sentObj.type).toBe('prompt');
			expect(sentObj.message).toBe('Implement feature X');
			expect(typeof sentObj.id).toBe('string');

			// Simulate agent response
			client.handleLine(
				JSON.stringify({
					id: sentObj.id,
					type: 'response',
					command: 'prompt',
					success: true,
				}),
			);

			const response = await promptPromise;
			expect(response.success).toBe(true);
			expect(response.command).toBe('prompt');

			client.dispose();
		});

		it('supports steer command to guide agent mid-run', async () => {
			let sentData = '';
			const client = createPiRpcClient({
				transport: {
					writeStdin(data: string | Buffer) {
						sentData = String(data);
						return true;
					},
				},
				requestTimeoutMs: 1000,
			});

			const steerPromise = client.steer('Stop and do this instead');
			const sentObj = JSON.parse(sentData.trim());
			expect(sentObj.type).toBe('steer');
			expect(sentObj.message).toBe('Stop and do this instead');

			client.handleLine(
				JSON.stringify({
					id: sentObj.id,
					type: 'response',
					command: 'steer',
					success: true,
				}),
			);

			const response = await steerPromise;
			expect(response.success).toBe(true);

			client.dispose();
		});

		it('supports abort command', async () => {
			let sentData = '';
			const client = createPiRpcClient({
				transport: {
					writeStdin(data: string | Buffer) {
						sentData = String(data);
						return true;
					},
				},
				requestTimeoutMs: 1000,
			});

			const abortPromise = client.abort();
			const sentObj = JSON.parse(sentData.trim());
			expect(sentObj.type).toBe('abort');

			client.handleLine(
				JSON.stringify({
					id: sentObj.id,
					type: 'response',
					command: 'abort',
					success: true,
				}),
			);

			const response = await abortPromise;
			expect(response.success).toBe(true);

			client.dispose();
		});

		it('supports get_state command and returns session state', async () => {
			let sentData = '';
			const client = createPiRpcClient({
				transport: {
					writeStdin(data: string | Buffer) {
						sentData = String(data);
						return true;
					},
				},
				requestTimeoutMs: 1000,
			});

			const statePromise = client.getState();
			const sentObj = JSON.parse(sentData.trim());
			expect(sentObj.type).toBe('get_state');

			client.handleLine(
				JSON.stringify({
					id: sentObj.id,
					type: 'response',
					command: 'get_state',
					success: true,
					data: {
						sessionId: 'sess_123',
						isStreaming: false,
						thinkingLevel: 'medium',
					},
				}),
			);

			const state = await statePromise;
			expect(state.sessionId).toBe('sess_123');
			expect(state.thinkingLevel).toBe('medium');

			client.dispose();
		});

		it('ignores unknown vendor event types and increments unmapped count without crashing (E-202)', () => {
			const tracker = createPiEventTracker();
			const client = createPiRpcClient({
				tracker,
			});

			const envelopesReceived: unknown[] = [];
			client.onEnvelope((e) => envelopesReceived.push(e));

			const unmappedEvents: string[] = [];
			client.onUnmappedEvent((type) => unmappedEvents.push(type));

			// 1. Send unknown events (e.g. from future Pi v2 release)
			client.handleLine(
				JSON.stringify({
					type: 'future_v2_breakthrough_event',
					coolData: 123,
				}),
			);
			client.handleLine(
				JSON.stringify({
					type: 'experimental_memory_snapshot',
					payload: 'abc',
				}),
			);

			// Must not crash, must not emit fake envelopes
			expect(envelopesReceived.length).toBe(0);
			expect(client.unmappedEventCount).toBe(2);
			expect(tracker.unmappedTypes).toEqual([
				'future_v2_breakthrough_event',
				'experimental_memory_snapshot',
			]);
			expect(unmappedEvents).toEqual([
				'future_v2_breakthrough_event',
				'experimental_memory_snapshot',
			]);

			// 2. Client continues normal operation and handles known events
			client.handleLine(
				JSON.stringify({
					type: 'message_update',
					delta: 'Normal message continuation',
				}),
			);

			expect(envelopesReceived.length).toBe(1);
			expect((envelopesReceived[0] as { kind: string }).kind).toBe('agent_message_chunk');

			client.dispose();
		});

		it('rejects command on error response without crashing', async () => {
			let sentData = '';
			const client = createPiRpcClient({
				transport: {
					writeStdin(data: string | Buffer) {
						sentData = String(data);
						return true;
					},
				},
			});

			const promptPromise = client.prompt('Will fail');
			const sentObj = JSON.parse(sentData.trim());

			client.handleLine(
				JSON.stringify({
					id: sentObj.id,
					type: 'response',
					command: 'prompt',
					success: false,
					error: 'Agent busy',
				}),
			);

			await expect(promptPromise).rejects.toThrow(/Agent busy/);
			client.dispose();
		});
	});

	describe('4) agent_settled 映射为运行结束信号 (AC 4)', () => {
		it('mapPiEvents maps agent_settled to run.exited and run.state_changed', () => {
			const rawEvent = { type: 'agent_settled' };
			const envelopes = mapPiEvents(rawEvent, { runId: 'run-settle-1' });

			expect(envelopes.length).toBe(2);

			const stateChanged = envelopes.find((e) => e.kind === 'run.state_changed');
			expect(stateChanged).toBeDefined();
			expect(stateChanged?.payload).toMatchObject({
				from: 'running',
				to: 'completed',
				reason: 'agent_settled',
			});

			const runExited = envelopes.find((e) => e.kind === 'run.exited');
			expect(runExited).toBeDefined();
			expect(runExited?.payload).toMatchObject({
				exitCode: 0,
				signal: null,
			});
		});

		it('PiRpcClient waitForSettled resolves when agent_settled is emitted', async () => {
			const client = createPiRpcClient();
			expect(client.isSettled).toBe(false);

			const settledPromise = client.waitForSettled(2000);

			client.handleLine(JSON.stringify({ type: 'agent_settled' }));

			await expect(settledPromise).resolves.toBeUndefined();
			expect(client.isSettled).toBe(true);

			// Subsequent wait returns immediately
			await expect(client.waitForSettled()).resolves.toBeUndefined();

			client.dispose();
		});
	});

	describe('5) event mapping: tool execution, plan, and streaming text', () => {
		it('maps tool_execution_start to tool_call and tool_execution_end to tool_call_update', () => {
			const startEnvelopes = mapPiEvents({
				type: 'tool_execution_start',
				toolCallId: 'call_99',
				toolName: 'bash',
				args: { command: 'git status' },
			});

			expect(startEnvelopes.length).toBe(1);
			expect(startEnvelopes[0]?.kind).toBe('tool_call');
			expect(startEnvelopes[0]?.payload).toMatchObject({
				callId: 'call_99',
				tool: 'bash',
				input: { command: 'git status' },
			});

			const endEnvelopes = mapPiEvents({
				type: 'tool_execution_end',
				toolCallId: 'call_99',
				result: 'On branch main',
				isError: false,
			});

			expect(endEnvelopes.length).toBe(1);
			expect(endEnvelopes[0]?.kind).toBe('tool_call_update');
			expect(endEnvelopes[0]?.payload).toMatchObject({
				callId: 'call_99',
				output: 'On branch main',
			});
		});

		it('maps plan event to plan envelope', () => {
			const planEnvelopes = mapPiEvents({
				type: 'plan',
				entries: [{ step: 1, title: 'Read files' }],
			});

			expect(planEnvelopes.length).toBe(1);
			expect(planEnvelopes[0]?.kind).toBe('plan');
			expect(planEnvelopes[0]?.payload).toMatchObject({
				entries: [{ step: 1, title: 'Read files' }],
			});
		});

		it('returns empty array for unparseable raw string without throwing (E-140)', () => {
			expect(mapPiEvents('<<< corrupted garbage stdout line >>>')).toEqual([]);
			expect(mapPiEvents('')).toEqual([]);
			expect(mapPiEvents(null)).toEqual([]);
		});

		it('checks isKnownPiEventType correctly', () => {
			expect(isKnownPiEventType('agent_settled')).toBe(true);
			expect(isKnownPiEventType('message_update')).toBe(true);
			expect(isKnownPiEventType('tool_execution_start')).toBe(true);
			expect(isKnownPiEventType('unknown_foo')).toBe(false);
		});
	});
});
