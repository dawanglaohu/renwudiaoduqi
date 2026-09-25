#!/usr/bin/env node

/**
 * Fake codex agent script for E2E smoke tests (M1-T11, AC 3, AC 4, E-135).
 * Emits version fingerprint when invoked with --version, and NDJSON conforming
 * to Codex event specifications when executed in run mode.
 */

if (
	process.argv.includes('--version') ||
	process.argv.includes('-V') ||
	process.argv.includes('-v')
) {
	process.stdout.write('codex 0.1.0 (smoke-test)\n');
	process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	// 1. Thread started
	process.stdout.write(
		`${JSON.stringify({
			type: 'thread.started',
			thread_id: 'thread-smoke-e2e',
		})}\n`,
	);
	await sleep(150);

	// 2. Turn started
	process.stdout.write(
		`${JSON.stringify({
			type: 'turn.started',
			turn_id: 'turn-smoke-e2e',
		})}\n`,
	);
	await sleep(150);

	// 3. Agent message delta (maps directly to agent_message_chunk)
	process.stdout.write(
		`${JSON.stringify({
			method: 'item/agentMessage/delta',
			params: {
				delta: 'Smoke test message chunk received successfully\n',
			},
		})}\n`,
	);
	await sleep(150);

	// 4. Completed message item
	process.stdout.write(
		`${JSON.stringify({
			type: 'item.completed',
			item: {
				id: 'msg-smoke-1',
				type: 'agentMessage',
				text: 'Smoke test message chunk received successfully\n',
			},
		})}\n`,
	);
	await sleep(200);

	// 5. Turn completed
	process.stdout.write(
		`${JSON.stringify({
			type: 'turn.completed',
			turn_id: 'turn-smoke-e2e',
		})}\n`,
	);

	// Wait briefly to allow daemon to drain stdout
	await sleep(800);
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`[fake-agent error] ${err?.stack || err}\n`);
	process.exit(1);
});
