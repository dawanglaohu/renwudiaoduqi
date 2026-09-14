import { describe, expect, it } from 'vitest';
import {
	ACTUAL_MODEL_PREFIX,
	DSH_STREAMING_NOTICE,
	TOKEN_MISSING_PLACEHOLDER,
	calculateDurationMs,
	checkModelMismatch,
	createProgressExtractor,
	extractChangedFileCount,
	extractProgress,
	extractReportedModel,
	extractTokenUsage,
	formatDurationText,
	formatTokenDisplay,
	hasStreamingCapability,
	resolveModelProgressInfo,
} from '../../src/domain/progress.ts';

describe('M6-T3 Progress Signals and Common Field Extraction', () => {
	describe('AC 1 & E-253: Common logic for 5 agents & dsh non-streaming handling', () => {
		it('extracts streaming lastMessage across Codex, Claude, Pi, and Grok events without deep semantic parsing', () => {
			// 1. Codex: agent_message_chunk stream
			const codexEvents = [
				{ kind: 'run.started', seq: 0, ts: '2026-09-01T10:00:00.000Z', payload: {} },
				{
					kind: 'agent_message_chunk',
					seq: 1,
					ts: '2026-09-01T10:00:01.000Z',
					payload: { chunk: 'Analyzing ' },
				},
				{
					kind: 'agent_message_chunk',
					seq: 2,
					ts: '2026-09-01T10:00:02.000Z',
					payload: { chunk: 'workspace files...' },
				},
			];
			const codexProgress = extractProgress({
				agentId: 'codex',
				state: 'running',
				events: codexEvents,
			});
			expect(codexProgress.lastMessage).toBe('Analyzing workspace files...');
			expect(codexProgress.hasStreamingEvents).toBe(true);
			expect(codexProgress.stepDurationDegraded).toBe(false);
			expect(codexProgress.streamingNotice).toBeNull();

			// 2. Claude: delta stream
			const claudeEvents = [
				{
					kind: 'run.started',
					seq: 0,
					ts: '2026-09-01T10:00:00.000Z',
					payload: { actualModel: 'claude-3-7-sonnet-20250219' },
				},
				{
					kind: 'agent_message_chunk',
					seq: 1,
					ts: '2026-09-01T10:00:01.000Z',
					payload: { delta: 'Task completed successfully.' },
				},
			];
			const claudeProgress = extractProgress({
				agentId: 'claude',
				state: 'running',
				events: claudeEvents,
			});
			expect(claudeProgress.lastMessage).toBe('Task completed successfully.');

			// 3. Pi: agent_message_chunk
			const piEvents = [
				{
					kind: 'agent_message_chunk',
					seq: 1,
					ts: '2026-09-01T10:00:01.000Z',
					payload: { chunk: 'Writing tests for M6-T3.' },
				},
			];
			const piProgress = extractProgress({
				agentId: 'pi',
				state: 'running',
				events: piEvents,
			});
			expect(piProgress.lastMessage).toBe('Writing tests for M6-T3.');

			// 4. Grok: ACP sessionUpdate chunk
			const grokEvents = [
				{
					kind: 'agent_message_chunk',
					seq: 1,
					ts: '2026-09-01T10:00:01.000Z',
					payload: { text: 'All criteria satisfied.' },
				},
			];
			const grokProgress = extractProgress({
				agentId: 'grok',
				state: 'running',
				events: grokEvents,
			});
			expect(grokProgress.lastMessage).toBe('All criteria satisfied.');
		});

		it('E-253: dsh in running state has hasStreamingEvents=false, lastMessage=null, degraded step duration, and notice', () => {
			const dshProgress = extractProgress({
				agentId: 'dsh',
				state: 'running',
				startedAt: '2026-09-01T10:00:00.000Z',
				now: '2026-09-01T10:02:30.000Z',
				events: [], // No intermediate events
			});

			// Capability is false, forbidden from fabricating fake events
			expect(dshProgress.hasStreamingEvents).toBe(false);
			expect(hasStreamingCapability('dsh')).toBe(false);
			expect(dshProgress.stepDurationDegraded).toBe(true);
			expect(dshProgress.lastMessage).toBeNull();
			expect(dshProgress.streamingNotice).toBe(DSH_STREAMING_NOTICE);
			expect(dshProgress.durationMs).toBe(150000);
			expect(dshProgress.durationText).toBe('2m 30s');
		});

		it('E-253: dsh populates final fields upon completion without intermediate fake events', () => {
			const finalOutput = 'Implemented all required domain logic for M6-T3.';
			const dshCompleted = extractProgress({
				agentId: 'dsh',
				state: 'exited',
				startedAt: '2026-09-01T10:00:00.000Z',
				endedAt: '2026-09-01T10:03:00.000Z',
				finalOutput,
				diffStat: { changedFileCount: 2, filesChanged: 2 },
				events: [],
			});

			expect(dshCompleted.isCompleted).toBe(true);
			expect(dshCompleted.hasStreamingEvents).toBe(false);
			expect(dshCompleted.stepDurationDegraded).toBe(true);
			expect(dshCompleted.streamingNotice).toBeNull();
			expect(dshCompleted.lastMessage).toBe(finalOutput);
			expect(dshCompleted.changedFileCount).toBe(2);
			expect(dshCompleted.durationMs).toBe(180000);
			expect(dshCompleted.durationText).toBe('3m 0s');
		});
	});

	describe('AC 2 & E-26: Token usage extraction, variations, and missing placeholders', () => {
		it('extracts standard and vendor-nested token fields across variations', () => {
			// Direct prompt_tokens / completion_tokens
			const u1 = extractTokenUsage({
				prompt_tokens: 1250,
				completion_tokens: 320,
				total_tokens: 1570,
			});
			expect(u1).toEqual({
				inputTokens: 1250,
				outputTokens: 320,
				totalTokens: 1570,
			});

			// camelCase inputTokens / outputTokens in usage object
			const u2 = extractTokenUsage({
				usage: {
					inputTokens: 500,
					outputTokens: 100,
				},
			});
			expect(u2).toEqual({
				inputTokens: 500,
				outputTokens: 100,
				totalTokens: 600, // Computed when both exist
			});

			// Nested in vendor.tokenUsage
			const u3 = extractTokenUsage({
				vendor: {
					tokenUsage: {
						promptTokens: '800',
						completionTokens: '200',
						totalTokens: '1000',
					},
				},
			});
			expect(u3).toEqual({
				inputTokens: 800,
				outputTokens: 200,
				totalTokens: 1000,
			});
		});

		it('E-26: missing or unparseable token fields strictly yield null and display "—", NEVER 0', () => {
			// Completely empty / missing token fields
			const emptyUsage = extractTokenUsage({});
			expect(emptyUsage).toBeNull();

			const emptyDisplay = formatTokenDisplay(emptyUsage);
			expect(emptyDisplay.input).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(emptyDisplay.output).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(emptyDisplay.total).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(emptyDisplay.summary).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(emptyDisplay.input).not.toBe('0');
			expect(emptyDisplay.total).not.toBe('0');

			// Partial tokens: only inputTokens present, output and total missing
			const partialUsage = extractTokenUsage({
				input_tokens: 450,
			});
			expect(partialUsage).toEqual({
				inputTokens: 450,
				outputTokens: null,
				totalTokens: null,
			});
			expect(partialUsage?.outputTokens).toBeNull();
			expect(partialUsage?.outputTokens).not.toBe(0);
			expect(partialUsage?.totalTokens).toBeNull();
			expect(partialUsage?.totalTokens).not.toBe(0);

			const partialDisplay = formatTokenDisplay(partialUsage);
			expect(partialDisplay.input).toBe('450');
			expect(partialDisplay.output).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(partialDisplay.total).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(partialDisplay.summary).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(partialDisplay.output).not.toBe('0');

			// Total tokens present, input and output missing
			const totalOnly = extractTokenUsage({
				total_tokens: 15000,
			});
			expect(totalOnly).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: 15000,
			});
			const totalOnlyDisplay = formatTokenDisplay(totalOnly);
			expect(totalOnlyDisplay.input).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(totalOnlyDisplay.output).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(totalOnlyDisplay.total).toBe('15,000');
			expect(totalOnlyDisplay.summary).toBe('15k');
			expect(totalOnlyDisplay.input).not.toBe('0');
		});

		it('E-26: non-numeric, negative, NaN or invalid units are treated as missing null, NEVER 0', () => {
			const invalidUsage = extractTokenUsage({
				usage: {
					input_tokens: -10,
					output_tokens: 'unlimited',
					total_tokens: Number.NaN,
				},
			});
			expect(invalidUsage).toEqual({
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
			});

			const display = formatTokenDisplay(invalidUsage);
			expect(display.input).toBe('—');
			expect(display.output).toBe('—');
			expect(display.total).toBe('—');
			expect(display.summary).toBe('—');
			expect(display.input).not.toBe('0');
			expect(display.output).not.toBe('0');
		});
	});

	describe('AC 3 & E-37: Self-reported model extraction & mismatch highlighting', () => {
		it('extracts reportedModel from first frame and flags mismatch when different from selected model', () => {
			// First frame reports claude-3-5-haiku while user selected claude-3-5-sonnet
			const firstFrame = {
				kind: 'run.started',
				seq: 0,
				ts: '2026-09-01T10:00:00.000Z',
				payload: {
					actualModel: 'claude-3-5-haiku-20241022',
				},
			};

			const reported = extractReportedModel(firstFrame);
			expect(reported).toBe('claude-3-5-haiku-20241022');

			const mismatch = checkModelMismatch('claude-3-5-sonnet-20241022', reported);
			expect(mismatch).toBe(true);

			const modelInfo = resolveModelProgressInfo('claude-3-5-sonnet-20241022', reported);
			expect(modelInfo.reportedModel).toBe('claude-3-5-haiku-20241022');
			expect(modelInfo.selectedModel).toBe('claude-3-5-sonnet-20241022');
			expect(modelInfo.modelMismatch).toBe(true);
			expect(modelInfo.isMismatchHighlighted).toBe(true);
			expect(modelInfo.displayActualModel).toBe(`${ACTUAL_MODEL_PREFIX}claude-3-5-haiku-20241022`);
		});

		it('does not highlight mismatch when reported model matches selected model (case/whitespace insensitive)', () => {
			const firstFrame = {
				kind: 'run.started',
				payload: {
					reportedModel: 'Claude-3-7-Sonnet ',
				},
			};

			const reported = extractReportedModel(firstFrame);
			expect(reported).toBe('Claude-3-7-Sonnet');

			const modelInfo = resolveModelProgressInfo('claude-3-7-sonnet', reported);
			expect(modelInfo.modelMismatch).toBe(false);
			expect(modelInfo.isMismatchHighlighted).toBe(false);
			expect(modelInfo.displayActualModel).toBe(`${ACTUAL_MODEL_PREFIX}Claude-3-7-Sonnet`);
		});

		it('E-37: agents without first-frame capability remain unknown (reportedModel=null) and do not guess', () => {
			// Codex, Pi, or generic agent without model in first frame
			const codexFirstFrame = {
				kind: 'run.started',
				seq: 0,
				payload: {
					runId: 'run-codex-1',
				},
			};

			const reported = extractReportedModel(codexFirstFrame);
			expect(reported).toBeNull();

			// Selected model is set, but reported is unknown: must NOT guess or flag mismatch
			const modelInfo = resolveModelProgressInfo('o3-mini', reported);
			expect(modelInfo.reportedModel).toBeNull();
			expect(modelInfo.selectedModel).toBe('o3-mini');
			expect(modelInfo.modelMismatch).toBe(false);
			expect(modelInfo.isMismatchHighlighted).toBe(false);
			expect(modelInfo.displayActualModel).toBeNull();
		});

		it('extracts reported model from raw system/init or vendor format if present', () => {
			const vendorFirstFrame = {
				type: 'system',
				subtype: 'init',
				model: 'claude-3-opus-20240229',
			};
			expect(extractReportedModel(vendorFirstFrame)).toBe('claude-3-opus-20240229');
		});
	});

	describe('M5-T3 Diff Input and Changed File Count', () => {
		it('extracts changedFileCount strictly from diffStat without parsing tool events', () => {
			// From DiffStatResult structure
			const count1 = extractChangedFileCount({
				changedFileCount: 5,
				filesChanged: 5,
				files: [],
			});
			expect(count1).toBe(5);

			// From filesChanged fallback
			const count2 = extractChangedFileCount({
				filesChanged: 3,
			});
			expect(count2).toBe(3);

			// Explicit number count
			const count3 = extractChangedFileCount(null, 4);
			expect(count3).toBe(4);

			// Missing diff
			const countMissing = extractChangedFileCount(null, null);
			expect(countMissing).toBeNull();
		});
	});

	describe('Duration and Timestamp Calculations', () => {
		it('calculates duration in ms and formats cleanly without Chinese sentences', () => {
			// Ended run
			const ms1 = calculateDurationMs('2026-09-01T10:00:00.000Z', '2026-09-01T10:00:42.600Z');
			expect(ms1).toBe(42600);
			expect(formatDurationText(ms1)).toBe('42.6s');

			// Multi-minute run
			const ms2 = calculateDurationMs('2026-09-01T10:00:00.000Z', '2026-09-01T10:05:12.000Z');
			expect(ms2).toBe(312000);
			expect(formatDurationText(ms2)).toBe('5m 12s');

			// Sub-second
			expect(formatDurationText(400)).toBe('<1s');

			// In-flight run using injected now
			const msInFlight = calculateDurationMs(
				'2026-09-01T10:00:00.000Z',
				null,
				'2026-09-01T10:01:15.000Z',
			);
			expect(msInFlight).toBe(75000);
			expect(formatDurationText(msInFlight)).toBe('1m 15s');

			// Invalid input returns null
			expect(calculateDurationMs(null)).toBeNull();
			expect(formatDurationText(null)).toBeNull();
		});
	});

	describe('ProgressExtractor State Machine and Stream Ingestion', () => {
		it('incrementally tracks events, tokens, diffs, and completion', () => {
			const extractor = createProgressExtractor({
				runId: 'run-live-1',
				agentId: 'claude',
				selectedModel: 'claude-3-5-sonnet',
				startedAt: '2026-09-01T12:00:00.000Z',
			});

			// Frame 1: system init with self-reported model
			extractor.pushEvent({
				kind: 'run.started',
				seq: 0,
				ts: '2026-09-01T12:00:01.000Z',
				payload: { actualModel: 'claude-3-5-haiku' },
			});

			// Frame 2: assistant chunks
			extractor.pushEvent({
				kind: 'agent_message_chunk',
				seq: 1,
				ts: '2026-09-01T12:00:02.000Z',
				payload: { chunk: 'Processing...' },
			});

			let p = extractor.getProgress('2026-09-01T12:00:05.000Z');
			expect(p.lastMessage).toBe('Processing...');
			expect(p.modelInfo.modelMismatch).toBe(true);
			expect(p.modelInfo.isMismatchHighlighted).toBe(true);
			expect(p.modelInfo.displayActualModel).toBe('实际使用：claude-3-5-haiku');
			expect(p.tokenDisplay.total).toBe(TOKEN_MISSING_PLACEHOLDER);
			expect(p.lastEventAt).toBe('2026-09-01T12:00:02.000Z');
			expect(p.durationText).toBe('5.0s');

			// Frame 3: tokens arrive
			extractor.pushEvent({
				kind: 'tool_call_update',
				seq: 2,
				ts: '2026-09-01T12:00:08.000Z',
				payload: {
					tokenUsage: {
						inputTokens: 1200,
						outputTokens: 300,
					},
				},
			});

			// Update diff
			extractor.setDiffStat({ changedFileCount: 3 });

			// Complete run
			extractor.complete({ endedAt: '2026-09-01T12:00:10.000Z' });

			p = extractor.getProgress();
			expect(p.isCompleted).toBe(true);
			expect(p.changedFileCount).toBe(3);
			expect(p.tokenUsage).toEqual({
				inputTokens: 1200,
				outputTokens: 300,
				totalTokens: 1500,
			});
			expect(p.tokenDisplay.input).toBe('1,200');
			expect(p.tokenDisplay.output).toBe('300');
			expect(p.tokenDisplay.total).toBe('1,500');
			expect(p.tokenDisplay.summary).toBe('1.5k');
			expect(p.durationMs).toBe(10000);
			expect(p.durationText).toBe('10.0s');
			expect(p.lastEventAt).toBe('2026-09-01T12:00:08.000Z');
		});

		it('handles clock backward anomaly gracefully by clamping duration to 0', () => {
			const ms = calculateDurationMs('2026-09-01T12:05:00.000Z', '2026-09-01T12:00:00.000Z');
			expect(ms).toBe(0);
			expect(formatDurationText(ms)).toBe('<1s');
		});

		it('does not leak subsequent model strings into first-frame reportedModel (E-37)', () => {
			const events = [
				{
					kind: 'run.started',
					seq: 0,
					payload: { runId: 'run-codex-9' },
				},
				{
					kind: 'tool_call',
					seq: 1,
					payload: { tool: 'model_checker', input: { model: 'gpt-4o' } },
				},
			];

			const progress = extractProgress({
				agentId: 'codex',
				selectedModel: 'o3-mini',
				events,
			});

			// Reported model must stay null since the first frame didn't self-report
			expect(progress.modelInfo.reportedModel).toBeNull();
			expect(progress.modelInfo.modelMismatch).toBe(false);
			expect(progress.modelInfo.isMismatchHighlighted).toBe(false);
		});

		it('E-26: comprehensive field variations for token extraction', () => {
			// All 18 name variations across input, output, total
			const variations = [
				{ input: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
				{ input: { prompt_tokens: 10, completion_tokens: 20, totalTokens: 30 } },
				{ input: { inputTokens: 10, outputTokens: 20, total_token_count: 30 } },
				{ input: { promptTokens: 10, completionTokens: 20, total_count: 30 } },
				{ input: { input_token_count: 10, output_token_count: 20, total: 30 } },
				{ input: { input_count: 10, output_count: 20, total_tokens: 30 } },
				{ input: { input: 10, output: 20, total: 30 } },
			];

			for (const { input } of variations) {
				const usage = extractTokenUsage(input);
				expect(usage).toEqual({
					inputTokens: 10,
					outputTokens: 20,
					totalTokens: 30,
				});
				const display = formatTokenDisplay(usage);
				expect(display.input).toBe('10');
				expect(display.output).toBe('20');
				expect(display.total).toBe('30');
			}
		});

		it('E-253: dsh terminal states all trigger completed state with final fields', () => {
			const terminalStates = ['exited', 'landed', 'failed', 'aborted', 'interrupted'];
			for (const state of terminalStates) {
				const progress = extractProgress({
					agentId: 'dsh',
					state,
					startedAt: '2026-09-01T10:00:00.000Z',
					endedAt: '2026-09-01T10:01:00.000Z',
					finalOutput: `dsh finished with status ${state}`,
					diffStat: { changedFileCount: 1 },
				});

				expect(progress.isCompleted).toBe(true);
				expect(progress.lastMessage).toBe(`dsh finished with status ${state}`);
				expect(progress.changedFileCount).toBe(1);
				expect(progress.streamingNotice).toBeNull();
				expect(progress.hasStreamingEvents).toBe(false);
				expect(progress.stepDurationDegraded).toBe(true);
			}
		});
	});
});
