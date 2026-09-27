#!/usr/bin/env node

/**
 * Fake codex agent script for E2E smoke tests (M1-T11, AC 3, AC 4, E-135).
 * Emits version fingerprint when invoked with --version, and NDJSON conforming
 * to Codex event specifications when executed in run mode.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

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

// Stdio JSON-RPC handler for codex app-server protocol (session.start handshakes)
let activeThreadId = 'thread-smoke-e2e';
let activeTurnId = 'turn-smoke-e2e';

const rl = readline.createInterface({
	input: process.stdin,
	terminal: false,
});

rl.on('line', (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		const msg = JSON.parse(trimmed);
		if (msg && typeof msg === 'object' && msg.id !== undefined) {
			const method = msg.method;
			if (method === 'initialize') {
				process.stdout.write(
					`${JSON.stringify({
						id: msg.id,
						result: {
							serverInfo: {
								name: 'fake-codex',
								version: '0.1.0',
							},
						},
					})}\n`,
				);
			} else if (method === 'thread/start') {
				process.stdout.write(
					`${JSON.stringify({
						id: msg.id,
						result: {
							thread: {
								id: activeThreadId,
							},
						},
					})}\n`,
				);
			} else if (method === 'turn/start') {
				process.stdout.write(
					`${JSON.stringify({
						id: msg.id,
						result: {
							turn: {
								id: activeTurnId,
								status: 'in_progress',
							},
						},
					})}\n`,
				);
			} else {
				process.stdout.write(
					`${JSON.stringify({
						id: msg.id,
						result: {},
					})}\n`,
				);
			}
		}
	} catch {
		// Ignore non-json lines
	}
});

async function main() {
	// 1. Thread started (both vendor event formats for backward compatibility)
	process.stdout.write(
		`${JSON.stringify({
			method: 'thread/started',
			params: {
				threadId: activeThreadId,
			},
		})}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({
			type: 'thread.started',
			thread_id: activeThreadId,
		})}\n`,
	);
	await sleep(100);

	// 2. Turn started (both vendor event formats)
	process.stdout.write(
		`${JSON.stringify({
			method: 'turn/started',
			params: {
				threadId: activeThreadId,
				turn: {
					id: activeTurnId,
				},
			},
		})}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({
			type: 'turn.started',
			turn_id: activeTurnId,
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
	const chunk2Text = await waitForSignal('agsched-fake-agent-2.signal', 45000);
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

	// 5. Completed message item (both JSON-RPC and legacy event format)
	process.stdout.write(
		`${JSON.stringify({
			method: 'item/completed',
			params: {
				item: {
					id: 'msg-smoke-1',
					type: 'agentMessage',
					text: chunk1Text,
				},
			},
		})}\n`,
	);
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

	// 6. Turn completed (JSON-RPC notification sets turnExitCode = 0 in daemon)
	process.stdout.write(
		`${JSON.stringify({
			method: 'turn/completed',
			params: {
				threadId: activeThreadId,
				turn: {
					id: activeTurnId,
					status: 'completed',
				},
			},
		})}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({
			type: 'turn.completed',
			turn_id: activeTurnId,
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
