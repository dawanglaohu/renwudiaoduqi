import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
import { PERMISSION_TIERS } from '../../src/domain/permission-tier.ts';

describe('M4-T11 grok 原生适配器', () => {
	describe('1. buildLaunchSpec (AC 1, AC 3, AC 4)', () => {
		it('AC 1: enforces `--output-format streaming-json` for ACP native output', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-1',
				cwd: '/workspace/test',
				prompt: 'fix the bug',
			});

			expect(spec.file).toBe('grok');
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
				prompt: 'fix the bug',
				argsTemplate: ['--output-format', 'plain'],
			});

			const idx = spec.args.indexOf('--output-format');
			expect(spec.args[idx + 1]).toBe('streaming-json');
		});

		it('AC 3: passes prompt via `-p` argument and does NOT read piped stdin', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-prompt-arg',
				cwd: '/workspace/test',
				prompt: 'implement feature X',
			});

			expect(spec.args).toContain('-p');
			const pIdx = spec.args.indexOf('-p');
			expect(spec.args[pIdx + 1]).toBe('implement feature X');
			expect(spec.args).not.toContain('--prompt-file');
		});

		it('AC 3: passes prompt via `--prompt-file` when promptFile is provided', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-prompt-file',
				cwd: '/workspace/test',
				promptFile: '/tmp/prompts/task-1.md',
			});

			expect(spec.args).toContain('--prompt-file');
			const pfIdx = spec.args.indexOf('--prompt-file');
			expect(spec.args[pfIdx + 1]).toBe('/tmp/prompts/task-1.md');
			expect(spec.args).not.toContain('-p');
		});

		it('maps three permission tiers correctly to `--permission-mode`', () => {
			const readOnlySpec = buildGrokLaunchSpec({
				runId: 'run-ro',
				cwd: '/workspace/test',
				permissionTier: PERMISSION_TIERS.READ_ONLY,
			});
			expect(readOnlySpec.args).toContain('--permission-mode');
			const roIdx = readOnlySpec.args.indexOf('--permission-mode');
			expect(readOnlySpec.args[roIdx + 1]).toBe('plan');

			const writeSpec = buildGrokLaunchSpec({
				runId: 'run-write',
				cwd: '/workspace/test',
				permissionTier: PERMISSION_TIERS.WORKSPACE_WRITE,
			});
			const writeIdx = writeSpec.args.indexOf('--permission-mode');
			expect(writeSpec.args[writeIdx + 1]).toBe('acceptEdits');

			const unresSpec = buildGrokLaunchSpec({
				runId: 'run-unres',
				cwd: '/workspace/test',
				permissionTier: PERMISSION_TIERS.UNRESTRICTED,
			});
			const unresIdx = unresSpec.args.indexOf('--permission-mode');
			expect(unresSpec.args[unresIdx + 1]).toBe('bypassPermissions');
		});

		it('maps reasoning effort tiers to `--reasoning-effort`', () => {
			const lowSpec = buildGrokLaunchSpec({
				runId: 'run-low',
				cwd: '/workspace/test',
				effortTier: 'low',
			});
			expect(lowSpec.args).toContain('--reasoning-effort');
			const lowIdx = lowSpec.args.indexOf('--reasoning-effort');
			expect(lowSpec.args[lowIdx + 1]).toBe('low');

			const medSpec = buildGrokLaunchSpec({
				runId: 'run-med',
				cwd: '/workspace/test',
				effortTier: 'medium',
			});
			const medIdx = medSpec.args.indexOf('--reasoning-effort');
			expect(medSpec.args[medIdx + 1]).toBe('medium');

			const highSpec = buildGrokLaunchSpec({
				runId: 'run-high',
				cwd: '/workspace/test',
				effortTier: 'high',
			});
			const highIdx = highSpec.args.indexOf('--reasoning-effort');
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

		it('performs template variable substitution on argsTemplate', () => {
			const spec = buildGrokLaunchSpec({
				runId: 'run-template',
				cwd: '/workspace/test',
				prompt: 'hello world',
				model: 'grok-3',
				sessionId: 'sess-123',
				worktree: 'wt-branch',
				worktreeRef: 'HEAD',
				argsTemplate: [
					'--custom-model',
					'{model}',
					'--custom-session',
					'{session_id}',
					'--worktree',
					'{worktree}',
					'--worktree-ref',
					'{worktree_ref}',
				],
			});

			expect(spec.args).toContain('--custom-model');
			expect(spec.args[spec.args.indexOf('--custom-model') + 1]).toBe('grok-3');
			expect(spec.args).toContain('--custom-session');
			expect(spec.args[spec.args.indexOf('--custom-session') + 1]).toBe('sess-123');
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

	describe('3. mapEvents (AC 1, AC 5, E-26, E-140, E-202)', () => {
		it('AC 1: directly consumes ACP agent_message_chunk as reference implementation', () => {
			const raw = JSON.stringify({
				type: 'agent_message_chunk',
				text: 'Hello from Grok ACP!',
			});

			const events = mapGrokEvents(raw, { runId: 'run-10' });
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('agent_message_chunk');
			expect(events[0]?.payload.chunk).toBe('Hello from Grok ACP!');
			expect(events[0]?.runId).toBe('run-10');
			expect(events[0]?.scope).toBe('run');
		});

		it('AC 1: supports delta and content aliases for agent_message_chunk', () => {
			const deltaEvents = mapGrokEvents(
				JSON.stringify({ type: 'agent_message_chunk', delta: 'Delta text' }),
			);
			expect(deltaEvents[0]?.payload.chunk).toBe('Delta text');

			const contentEvents = mapGrokEvents(
				JSON.stringify({ type: 'agent_message_chunk', content: 'Content text' }),
			);
			expect(contentEvents[0]?.payload.chunk).toBe('Content text');
		});

		it('AC 1: directly consumes ACP agent_thought_chunk', () => {
			const raw = JSON.stringify({
				type: 'agent_thought_chunk',
				text: 'Thinking deeply...',
			});

			const events = mapGrokEvents(raw);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('agent_thought_chunk');
			expect(events[0]?.payload.chunk).toBe('Thinking deeply...');
		});

		it('AC 1: directly consumes ACP tool_call and tool_call_update', () => {
			const callRaw = JSON.stringify({
				type: 'tool_call',
				callId: 'call_123',
				tool: 'bash',
				input: { command: 'git status' },
			});

			const callEvents = mapGrokEvents(callRaw);
			expect(callEvents).toHaveLength(1);
			expect(callEvents[0]?.kind).toBe('tool_call');
			expect(callEvents[0]?.payload.callId).toBe('call_123');
			expect(callEvents[0]?.payload.tool).toBe('bash');
			expect(callEvents[0]?.payload.input).toEqual({ command: 'git status' });

			const updateRaw = JSON.stringify({
				type: 'tool_call_update',
				callId: 'call_123',
				output: 'On branch main\nnothing to commit',
			});

			const updateEvents = mapGrokEvents(updateRaw);
			expect(updateEvents).toHaveLength(1);
			expect(updateEvents[0]?.kind).toBe('tool_call_update');
			expect(updateEvents[0]?.payload.callId).toBe('call_123');
			expect(updateEvents[0]?.payload.output).toBe('On branch main\nnothing to commit');
		});

		it('AC 1: directly consumes ACP plan and available_commands_update', () => {
			const planRaw = JSON.stringify({
				type: 'plan',
				entries: [
					{ task: 'inspect code', done: true },
					{ task: 'run test', done: false },
				],
			});
			const planEvents = mapGrokEvents(planRaw);
			expect(planEvents).toHaveLength(1);
			expect(planEvents[0]?.kind).toBe('plan');
			expect(planEvents[0]?.payload.entries).toHaveLength(2);

			const cmdRaw = JSON.stringify({
				type: 'available_commands_update',
				commands: ['help', 'export'],
			});
			const cmdEvents = mapGrokEvents(cmdRaw);
			expect(cmdEvents).toHaveLength(1);
			expect(cmdEvents[0]?.kind).toBe('available_commands_update');
			expect(cmdEvents[0]?.payload.commands).toEqual(['help', 'export']);
		});

		it('unwraps JSON-RPC notification envelopes { method: "session/update", params: { update: ... } }', () => {
			const rpcRaw = JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'sess-abc',
					update: {
						type: 'agent_message_chunk',
						text: 'RPC unwrapped text',
					},
				},
			});

			const events = mapGrokEvents(rpcRaw);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('agent_message_chunk');
			expect(events[0]?.payload.chunk).toBe('RPC unwrapped text');
		});

		it('maps lifecycle events: agent_start, turn_start, turn_complete, agent_settled', () => {
			const startEvents = mapGrokEvents(JSON.stringify({ type: 'agent_start' }));
			expect(startEvents.map((e) => e.kind)).toContain('run.started');
			expect(startEvents.map((e) => e.kind)).toContain('run.state_changed');

			const turnStartEvents = mapGrokEvents(JSON.stringify({ type: 'turn_start' }));
			expect(turnStartEvents[0]?.kind).toBe('run.state_changed');
			expect(turnStartEvents[0]?.payload.to).toBe('running');

			const settledEvents = mapGrokEvents(JSON.stringify({ type: 'agent_settled' }));
			expect(settledEvents.map((e) => e.kind)).toEqual(['run.state_changed', 'run.exited']);
			expect(settledEvents[0]?.payload.to).toBe('completed');
			expect(settledEvents[1]?.payload.exitCode).toBe(0);
		});

		it('AC 5 & E-26: missing token usage sets fields to null and NEVER 0', () => {
			// Test 1: empty object or event without usage
			const emptyUsage = extractGrokTokenUsage({});
			expect(emptyUsage).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});

			// Test 2: event with empty usage object
			const nullUsage = extractGrokTokenUsage({ usage: {} });
			expect(nullUsage).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});

			// Test 3: event with only prompt_tokens present; completion_tokens and total_tokens MUST be null, NOT 0
			const partialUsage = extractGrokTokenUsage({
				usage: {
					prompt_tokens: 150,
				},
			});
			expect(partialUsage).toEqual({
				inputTokens: 150,
				outputTokens: null,
				totalTokens: null,
			});
			expect(partialUsage?.outputTokens).not.toBe(0);
			expect(partialUsage?.totalTokens).not.toBe(0);

			// Test 4: event with all tokens provided
			const fullUsage = extractGrokTokenUsage({
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					total_tokens: 150,
				},
			});
			expect(fullUsage).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
			});

			// Test 5: non-numeric tokens (e.g. invalid strings or NaN) are set to null, NEVER 0
			const invalidUsage = extractGrokTokenUsage({
				usage: {
					prompt_tokens: 'unknown',
					completion_tokens: null,
				},
			});
			expect(invalidUsage).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});
		});

		it('AC 5 & E-26: turn_complete attaches tokenUsage with null fields when tokens are missing', () => {
			const events = mapGrokEvents(
				JSON.stringify({
					type: 'turn_complete',
					// No token usage provided
				}),
			);

			expect(events).toHaveLength(2);
			const stateChanged = events[0];
			const vendor = stateChanged?.payload.vendor as {
				tokenUsage?: { inputTokens: number | null; outputTokens: number | null };
			};
			expect(vendor.tokenUsage).toBeDefined();
			expect(vendor.tokenUsage?.inputTokens).toBeNull();
			expect(vendor.tokenUsage?.outputTokens).toBeNull();
			expect(vendor.tokenUsage?.inputTokens).not.toBe(0);
			expect(vendor.tokenUsage?.outputTokens).not.toBe(0);
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
				type: 'unknown_future_grok_feature_event',
				someData: 123,
			});

			const result = parseAndMapGrokLine(unknownLine, { tracker, onUnmapped });
			expect(result.events).toHaveLength(0);
			expect(result.unmappedCount).toBe(1);
			expect(tracker.unmappedCount).toBe(1);
			expect(tracker.unmappedTypes).toContain('unknown_future_grok_feature_event');
			expect(onUnmapped).toHaveBeenCalledWith(
				'unknown_future_grok_feature_event',
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
});
