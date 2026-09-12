import { describe, expect, it } from 'vitest';
import {
	CLAUDE_ENV_DENYLIST,
	buildClaudeAgentsQuerySpec,
	buildClaudeLaunchSpec,
	cleanClaudeEnv,
	findClaudeAgentSession,
	parseClaudeAgentsJson,
} from '../../src/adapters/claude/build-launch-spec.ts';
import {
	CLAUDE_CAPABILITIES,
	getClaudeCapabilities,
} from '../../src/adapters/claude/capabilities.ts';
import { createClaudeEventMapper, mapEvents } from '../../src/adapters/claude/map-events.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('M4-T9: claude 原生适配器', () => {
	describe('AC 1: --bg 与 -p 不同时使用，后台会话经 claude agents --json 回读', () => {
		it('buildClaudeLaunchSpec foreground mode uses -p/--print and stream-json format, without --bg', () => {
			const spec = buildClaudeLaunchSpec({
				runId: 'run-foreground-1',
				cwd: '/workspace/project',
				isBackground: false,
			});

			expect(spec.file).toBe('claude');
			expect(spec.args).toContain('--print');
			expect(spec.args).toContain('--output-format');
			expect(spec.args).toContain('stream-json');
			expect(spec.args).toContain('--input-format');
			expect(spec.args).not.toContain('--bg');
			expect(spec.args).not.toContain('--background');
		});

		it('buildClaudeLaunchSpec background mode uses --bg and strips -p/--print', () => {
			const spec = buildClaudeLaunchSpec({
				runId: 'run-bg-1',
				cwd: '/workspace/project',
				isBackground: true,
				argsTemplate: ['--print', '--output-format', 'stream-json', '--model', '{model}'],
				model: 'claude-3-7-sonnet-20250219',
				prompt: 'Build the feature',
			});

			expect(spec.args).toContain('--bg');
			expect(spec.args).not.toContain('-p');
			expect(spec.args).not.toContain('--print');
			expect(spec.args).toContain('--model');
			expect(spec.args).toContain('claude-3-7-sonnet-20250219');
			expect(spec.args).toContain('Build the feature');
		});

		it('throws E_VALIDATION if --bg and -p/--print are passed simultaneously in extraArgs', () => {
			expect(() => {
				buildClaudeLaunchSpec({
					runId: 'run-conflict-1',
					cwd: '/workspace/project',
					isBackground: true,
					extraArgs: ['--print'],
				});
			}).toThrow(AppError);

			try {
				buildClaudeLaunchSpec({
					runId: 'run-conflict-2',
					cwd: '/workspace/project',
					isBackground: false,
					extraArgs: ['--bg'],
				});
				expect.unreachable('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_VALIDATION');
			}
		});

		it('buildClaudeAgentsQuerySpec builds launch spec for claude agents --json', () => {
			const querySpec = buildClaudeAgentsQuerySpec({
				execPath: '/usr/local/bin/claude',
				cwd: '/workspace/my-app',
				all: true,
			});

			expect(querySpec.file).toBe('/usr/local/bin/claude');
			expect(querySpec.args).toEqual(['agents', '--json', '--all', '--cwd', '/workspace/my-app']);
			expect(querySpec.cwd).toBe('/workspace/my-app');
		});

		it('parseClaudeAgentsJson parses array output and extracts state, waitingFor, sessionId, pid', () => {
			const rawAgentsJson = JSON.stringify([
				{
					id: 'job_w123',
					state: 'working',
					waitingFor: null,
					sessionId: 'sess-uuid-001',
					pid: 4567,
					cwd: '/workspace/project',
					kind: 'subagent',
					startedAt: '2026-09-12T01:00:00.000Z',
					status: 'Running tool Bash',
					name: 'worker-1',
				},
				{
					id: 'job_b456',
					state: 'blocked',
					waitingFor: 'user_input',
					sessionId: 'sess-uuid-002',
					pid: 4568,
					cwd: '/workspace/project',
					status: 'Awaiting permission',
				},
				{
					id: 'job_d789',
					state: 'done',
					waitingFor: null,
					sessionId: 'sess-uuid-003',
					pid: 4569,
					status: 'Completed successfully',
				},
				{
					id: 'job_f012',
					state: 'failed',
					waitingFor: null,
					sessionId: 'sess-uuid-004',
					pid: 4570,
					status: 'Process crashed',
				},
				{
					id: 'job_s345',
					state: 'stopped',
					waitingFor: null,
					sessionId: 'sess-uuid-005',
					pid: 4571,
					status: 'Stopped by user',
				},
			]);

			const sessions = parseClaudeAgentsJson(rawAgentsJson);
			expect(sessions).toHaveLength(5);

			expect(sessions[0]).toMatchObject({
				id: 'job_w123',
				state: 'working',
				waitingFor: null,
				sessionId: 'sess-uuid-001',
				pid: 4567,
				cwd: '/workspace/project',
				kind: 'subagent',
				name: 'worker-1',
			});

			expect(sessions[1]).toMatchObject({
				id: 'job_b456',
				state: 'blocked',
				waitingFor: 'user_input',
				sessionId: 'sess-uuid-002',
				pid: 4568,
			});

			expect(sessions[2]?.state).toBe('done');
			expect(sessions[3]?.state).toBe('failed');
			expect(sessions[4]?.state).toBe('stopped');

			const found = findClaudeAgentSession(sessions, { sessionId: 'sess-uuid-002' });
			expect(found?.id).toBe('job_b456');
			expect(found?.waitingFor).toBe('user_input');
		});

		it('parseClaudeAgentsJson handles empty output and malformed JSON safely', () => {
			expect(parseClaudeAgentsJson('')).toEqual([]);
			expect(parseClaudeAgentsJson('   \n  ')).toEqual([]);

			expect(() => parseClaudeAgentsJson('not valid json')).toThrow(AppError);
			expect(() => parseClaudeAgentsJson('{"not": "an array"}')).toThrow(AppError);
		});
	});

	describe('AC 2 & E-37: 子进程环境清掉 ANTHROPIC_MODEL 与 ANTHROPIC_DEFAULT_*_MODEL，并从首帧读回自报实际模型', () => {
		it('cleanClaudeEnv strips ANTHROPIC_MODEL and all ANTHROPIC_DEFAULT_*_MODEL variables', () => {
			const dirtyEnv = {
				PATH: '/usr/bin',
				HOME: '/home/user',
				ANTHROPIC_MODEL: 'claude-3-5-sonnet-override',
				ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-haiku-override',
				ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-3-5-sonnet-latest',
				ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-3-opus-latest',
				ANTHROPIC_DEFAULT_CUSTOM_MODEL: 'custom-opus',
				ANTHROPIC_SMALL_MODEL: 'small',
				ANTHROPIC_MEDIUM_MODEL: 'medium',
				ANTHROPIC_LARGE_MODEL: 'large',
				OPENAI_MODEL: 'gpt-4o',
				KEEP_ME: 'safe-value',
			};

			const cleaned = cleanClaudeEnv(dirtyEnv);

			expect(cleaned.PATH).toBe('/usr/bin');
			expect(cleaned.HOME).toBe('/home/user');
			expect(cleaned.KEEP_ME).toBe('safe-value');

			expect(cleaned.ANTHROPIC_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_DEFAULT_CUSTOM_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_SMALL_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_MEDIUM_MODEL).toBeUndefined();
			expect(cleaned.ANTHROPIC_LARGE_MODEL).toBeUndefined();
			expect(cleaned.OPENAI_MODEL).toBeUndefined();
		});

		it('buildClaudeLaunchSpec cleans envOverrides and supplies CLAUDE_ENV_DENYLIST', () => {
			const spec = buildClaudeLaunchSpec({
				runId: 'run-env-clean',
				cwd: '/workspace',
				envOverrides: {
					MY_VAR: 'val',
					ANTHROPIC_MODEL: 'should-be-stripped',
					ANTHROPIC_DEFAULT_OPUS_MODEL: 'should-also-be-stripped',
				},
			});

			expect(spec.envOverrides).toEqual({ MY_VAR: 'val' });
			expect(spec.envDenylist).toEqual(CLAUDE_ENV_DENYLIST);
		});

		it('extracts self-reported actual model from first frame and detects match', () => {
			const mapper = createClaudeEventMapper({
				selectedModel: 'claude-3-7-sonnet-20250219',
				runId: 'run-m1',
			});

			const firstFrame = JSON.stringify({
				type: 'system',
				subtype: 'init',
				model: 'claude-3-7-sonnet-20250219',
				session_id: 'sess-abc-123',
				tools: ['Bash', 'Read'],
			});

			const result = mapper.mapLine(firstFrame);
			expect(result.isFirstFrame).toBe(true);
			expect(result.actualModel).toBe('claude-3-7-sonnet-20250219');
			expect(result.modelMismatch).toBe(false);
			expect(mapper.getActualModel()).toBe('claude-3-7-sonnet-20250219');
			expect(mapper.isModelMismatch()).toBe(false);

			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.kind).toBe('run.started');
			expect(result.events[0]?.payload).toMatchObject({
				actualModel: 'claude-3-7-sonnet-20250219',
				selectedModel: 'claude-3-7-sonnet-20250219',
				modelMismatch: false,
			});
		});

		it('flags modelMismatch when self-reported model differs from selected model (E-37)', () => {
			const mapper = createClaudeEventMapper({
				selectedModel: 'claude-3-5-sonnet-20241022',
				runId: 'run-mismatch-1',
			});

			const firstFrame = JSON.stringify({
				type: 'system/init',
				model: 'claude-3-5-haiku-20241022',
				session_id: 'sess-xyz-999',
			});

			const result = mapper.mapLine(firstFrame);
			expect(result.isFirstFrame).toBe(true);
			expect(result.actualModel).toBe('claude-3-5-haiku-20241022');
			expect(result.modelMismatch).toBe(true);
			expect(mapper.getActualModel()).toBe('claude-3-5-haiku-20241022');
			expect(mapper.isModelMismatch()).toBe(true);

			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.kind).toBe('run.started');
			expect(result.events[0]?.payload).toMatchObject({
				actualModel: 'claude-3-5-haiku-20241022',
				selectedModel: 'claude-3-5-sonnet-20241022',
				modelMismatch: true,
			});
		});

		it('does not re-process first frame on subsequent lines', () => {
			const mapper = createClaudeEventMapper({
				selectedModel: 'claude-3-7-sonnet',
			});

			mapper.mapLine(JSON.stringify({ type: 'system/init', model: 'claude-3-7-sonnet' }));

			const secondLine = JSON.stringify({
				type: 'text',
				text: 'Hello user!',
			});

			const result2 = mapper.mapLine(secondLine);
			expect(result2.isFirstFrame).toBe(false);
			expect(result2.events).toHaveLength(1);
			expect(result2.events[0]?.kind).toBe('agent_message_chunk');
			expect(result2.events[0]?.payload.chunk).toBe('Hello user!');
		});
	});

	describe('AC 3 & E-202: 未知厂商事件按 E-202 丢弃并对 runs.unmapped_event_count 计数，绝不崩溃也绝不臆造 kind', () => {
		it('discards unknown event types, increments unmappedCount, does not throw and does not invent fake kinds', () => {
			const mapper = createClaudeEventMapper();

			const unknownEvent1 = JSON.stringify({
				type: 'experimental_claude_future_telemetry',
				payload: { metric: 123 },
			});

			const res1 = mapper.mapLine(unknownEvent1);
			expect(res1.events).toHaveLength(0);
			expect(res1.unmappedCount).toBe(1);
			expect(mapper.getUnmappedEventCount()).toBe(1);

			const unknownEvent2 = JSON.stringify({
				some_custom_field: 'no_type_at_all',
				another_field: 42,
			});

			const res2 = mapper.mapLine(unknownEvent2);
			expect(res2.events).toHaveLength(0);
			expect(res2.unmappedCount).toBe(1);
			expect(mapper.getUnmappedEventCount()).toBe(2);
		});

		it('maps known Claude events to proper ACP session/update events without counting as unmapped', () => {
			const mapper = createClaudeEventMapper();

			// 1. Anthropic stream_event text_delta -> agent_message_chunk
			const textDelta = JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					delta: {
						type: 'text_delta',
						text: 'Streaming content...',
					},
				},
			});
			const r1 = mapper.mapLine(textDelta);
			expect(r1.unmappedCount).toBe(0);
			expect(r1.events).toHaveLength(1);
			expect(r1.events[0]?.kind).toBe('agent_message_chunk');
			expect(r1.events[0]?.payload.chunk).toBe('Streaming content...');

			// 2. Anthropic stream_event thinking_delta -> agent_thought_chunk
			const thinkingDelta = JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					delta: {
						type: 'thinking_delta',
						thinking: 'Analyzing code structure...',
					},
				},
			});
			const r2 = mapper.mapLine(thinkingDelta);
			expect(r2.unmappedCount).toBe(0);
			expect(r2.events).toHaveLength(1);
			expect(r2.events[0]?.kind).toBe('agent_thought_chunk');
			expect(r2.events[0]?.payload.chunk).toBe('Analyzing code structure...');

			// 3. Tool use -> tool_call
			const toolUse = JSON.stringify({
				type: 'tool_use',
				id: 'call_bash_001',
				name: 'Bash',
				input: { command: 'git status' },
			});
			const r3 = mapper.mapLine(toolUse);
			expect(r3.unmappedCount).toBe(0);
			expect(r3.events).toHaveLength(1);
			expect(r3.events[0]?.kind).toBe('tool_call');
			expect(r3.events[0]?.payload).toMatchObject({
				callId: 'call_bash_001',
				tool: 'Bash',
				input: { command: 'git status' },
			});

			// 4. Tool result -> tool_call_update
			const toolResult = JSON.stringify({
				type: 'tool_result',
				tool_use_id: 'call_bash_001',
				content: 'On branch task/M4-T9\nnothing to commit',
			});
			const r4 = mapper.mapLine(toolResult);
			expect(r4.unmappedCount).toBe(0);
			expect(r4.events).toHaveLength(1);
			expect(r4.events[0]?.kind).toBe('tool_call_update');
			expect(r4.events[0]?.payload).toMatchObject({
				callId: 'call_bash_001',
				output: 'On branch task/M4-T9\nnothing to commit',
			});

			// 5. Plan / Todo -> plan
			const planEvent = JSON.stringify({
				type: 'plan',
				entries: [
					{ step: 1, text: 'Inspect repo' },
					{ step: 2, text: 'Run tests' },
				],
			});
			const r5 = mapper.mapLine(planEvent);
			expect(r5.unmappedCount).toBe(0);
			expect(r5.events).toHaveLength(1);
			expect(r5.events[0]?.kind).toBe('plan');

			// 6. Known system events (ping, api_retry) -> gracefully ignored without unmapped count
			const pingEvent = JSON.stringify({ type: 'ping' });
			const r6 = mapper.mapLine(pingEvent);
			expect(r6.unmappedCount).toBe(0);
			expect(r6.events).toHaveLength(0);

			expect(mapper.getUnmappedEventCount()).toBe(0);
		});

		it('handles unparseable text lines without throwing or counting as unmapped events', () => {
			const mapper = createClaudeEventMapper();

			const r1 = mapper.mapLine('Just some raw stdout banner text');
			expect(r1.events).toHaveLength(0);
			expect(r1.unmappedCount).toBe(0);

			const r2 = mapper.mapLine('{ broken json');
			expect(r2.events).toHaveLength(0);
			expect(r2.unmappedCount).toBe(0);

			expect(mapper.getUnmappedEventCount()).toBe(0);
		});

		it('mapEvents pure function exports identical events array', () => {
			const events = mapEvents(JSON.stringify({ type: 'text', text: 'pure map test' }));
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('agent_message_chunk');
			expect(events[0]?.payload.chunk).toBe('pure map test');
		});
	});

	describe('AC 4: 能力位声明可回话为真（--input-format stream-json）', () => {
		it('declares canReply as true, supports streaming and stream-json input format', () => {
			const caps = getClaudeCapabilities();

			expect(caps.canReply).toBe(true);
			expect(caps.supportsReply).toBe(true);
			expect(caps.inputFormat).toBe('stream-json');
			expect(caps.outputFormat).toBe('stream-json');
			expect(caps.hasStreamingEvents).toBe(true);
			expect(caps.supportsStreaming).toBe(true);
			expect(caps.supportsBackground).toBe(true);
			expect(caps.sessionReadback).toBe('agents-json');

			expect(Object.isFrozen(caps)).toBe(true);
			expect(Object.isFrozen(caps.permissionModes)).toBe(true);
			expect(CLAUDE_CAPABILITIES).toBe(caps);
		});
	});
});
