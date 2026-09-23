import { describe, expect, it } from 'vitest';
import type { LogFileSystem } from '../../src/logstore/contract.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { readWrapupReportText } from '../../src/service/wrapup.ts';

const paths = createLogstorePaths('/logs');

function makeFs(files: Record<string, string>): LogFileSystem {
	const encoder = new TextEncoder();
	return {
		readFile: async (path: string) => {
			const normalized = path.replaceAll('\\', '/');
			const content = files[normalized];
			if (content === undefined) {
				throw Object.assign(new Error(`ENOENT: ${normalized}`), { code: 'ENOENT' });
			}
			return encoder.encode(content);
		},
	} as unknown as LogFileSystem;
}

function eventLine(kind: string, payload: unknown, id: number): string {
	return JSON.stringify({
		id,
		seq: id,
		ts: '2026-09-19T00:00:00.000Z',
		runId: 'run-w',
		taskId: null,
		scope: 'run',
		kind,
		actorDeviceId: null,
		payload,
	});
}

describe('M8-T6 F2: wrapup report text comes from the agent message stream, not the raw JSONL stdout', () => {
	it('concatenates agent_message_chunk deltas across event segments and ignores raw JSONL', async () => {
		const events0 = [
			eventLine('run.started', {}, 1),
			eventLine('agent_message_chunk', { chunk: '## BATCH_SUMMARY\n' }, 2),
			eventLine('agent_thought_chunk', { chunk: 'thinking…' }, 3),
			eventLine('agent_message_chunk', { chunk: '- 本批交付了' }, 4),
		].join('\n');
		const events1 = [
			eventLine('agent_message_chunk', { chunk: '两个任务\n\n## TESTS\npass\n' }, 5),
			eventLine('tool_call', { title: 'x' }, 6),
		].join('\n');
		const rawJsonl =
			'{"type":"item.completed","item":{"type":"agent_message","text":"## BATCH_SUMMARY"}}\n';
		const fs = makeFs({
			[paths.segmentPath('run-w', 'events', 0).replaceAll('\\', '/')]: `${events0}\n`,
			[paths.segmentPath('run-w', 'events', 1).replaceAll('\\', '/')]: `${events1}\n`,
			[paths.segmentPath('run-w', 'raw', 0).replaceAll('\\', '/')]: rawJsonl,
		});

		const text = await readWrapupReportText(paths, fs, 'run-w');
		expect(text).toBe('## BATCH_SUMMARY\n- 本批交付了两个任务\n\n## TESTS\npass\n');
		expect(text).not.toContain('item.completed');
	});

	it('falls back to the raw stream only when no agent_message_chunk was recorded (plain-text agents)', async () => {
		const fs = makeFs({
			[paths
				.segmentPath('run-w', 'events', 0)
				.replaceAll('\\', '/')]: `${eventLine('run.started', {}, 1)}\n`,
			[paths.segmentPath('run-w', 'raw', 0).replaceAll('\\', '/')]: '## BATCH_SUMMARY\nplain\n',
			[paths.segmentPath('run-w', 'raw', 1).replaceAll('\\', '/')]: '## TESTS\npass\n',
		});
		const text = await readWrapupReportText(paths, fs, 'run-w');
		expect(text).toBe('## BATCH_SUMMARY\nplain\n## TESTS\npass\n');
	});

	it('returns an empty string when neither stream exists', async () => {
		expect(await readWrapupReportText(paths, makeFs({}), 'run-none')).toBe('');
	});
});
