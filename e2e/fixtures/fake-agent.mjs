#!/usr/bin/env node

/**
 * Fake codex agent script for E2E smoke tests (M1-T11, AC 3, AC 4, E-135).
 * Emits version fingerprint when invoked with --version, and NDJSON conforming
 * to Codex event specifications when executed in run mode.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (
	process.argv.includes('--version') ||
	process.argv.includes('-V') ||
	process.argv.includes('-v')
) {
	process.stdout.write('codex 0.1.0 (smoke-test)\n');
	process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSignal(signalName, maxWaitMs = 8000) {
	const signalPath = path.join(process.env.AGSCHED_SMOKE_SIGNAL_DIR || os.tmpdir(), signalName);
	const start = Date.now();
	while (!fs.existsSync(signalPath) && Date.now() - start < maxWaitMs) {
		await sleep(50);
	}
	if (fs.existsSync(signalPath)) {
		try {
			const text = fs.readFileSync(signalPath, 'utf8').trim();
			return text || null;
		} catch {
			return null;
		}
	}
	return null;
}

async function main() {
	// 1. Thread started
	process.stdout.write(
		`${JSON.stringify({
			type: 'thread.started',
			thread_id: 'thread-smoke-e2e',
		})}\n`,
	);
	await sleep(100);

	// 2. Turn started
	process.stdout.write(
		`${JSON.stringify({
			type: 'turn.started',
			turn_id: 'turn-smoke-e2e',
		})}\n`,
	);
	await sleep(100);

	// 3. Wait for browser stream subscription signal before emitting live chunk (R2)
	const chunk1Text =
		(await waitForSignal('agsched-fake-agent-1.signal', 10000)) ||
		'Smoke test message chunk received successfully\n';

	// Agent message delta (maps directly to agent_message_chunk)
	process.stdout.write(
		`${JSON.stringify({
			method: 'item/agentMessage/delta',
			params: {
				delta: chunk1Text.endsWith('\n') ? chunk1Text : `${chunk1Text}\n`,
			},
		})}\n`,
	);
	await sleep(150);

	// 4. Optional second signal for negative control testing (SSE broken assertion)
	const chunk2Text = await waitForSignal('agsched-fake-agent-2.signal', 20000);
	if (chunk2Text) {
		process.stdout.write(
			`${JSON.stringify({
				method: 'item/agentMessage/delta',
				params: {
					delta: chunk2Text.endsWith('\n') ? chunk2Text : `${chunk2Text}\n`,
				},
			})}\n`,
		);
		await sleep(150);
	}

	// 5. Completed message item
	process.stdout.write(
		`${JSON.stringify({
			type: 'item.completed',
			item: {
				id: 'msg-smoke-1',
				type: 'agentMessage',
				text: chunk1Text,
			},
		})}\n`,
	);
	await sleep(200);

	// 6. Turn completed
	process.stdout.write(
		`${JSON.stringify({
			type: 'turn.completed',
			turn_id: 'turn-smoke-e2e',
		})}\n`,
	);

	// Wait briefly to allow daemon to drain stdout
	await sleep(500);
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`[fake-agent error] ${err?.stack || err}\n`);
	process.exit(1);
});
