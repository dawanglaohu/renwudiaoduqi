#!/usr/bin/env node
/**
 * Controllable registry agent for the document-execution end-to-end acceptance.
 * It is spawned by the production daemon as a normal agents.json entry.
 * Codex app-server and Claude stream-json are both spoken so a second built-in
 * id can take a task draft while the default agent is offline.
 *
 * Control file (AGSCHED_DOC_EXEC_CONTROL) is re-read at the start of each run:
 *   { "tasks": { "<taskKey>": "ok"|"hold"|"fail"|"slow" },
 *     "review": "pass"|"fail",
 *     "wrapup": "clean"|"fixed"|"open"|"fail"|"hold"|"garbage",
 *     "implementCommit": true }
 * Holding waits until AGSCHED_DOC_EXEC_RELEASE names the task key or "all".
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const persona = process.env.AGSCHED_DOC_EXEC_PERSONA === 'claude' ? 'claude' : 'codex';
const controlPath = process.env.AGSCHED_DOC_EXEC_CONTROL || '';
const journalPath = process.env.AGSCHED_DOC_EXEC_JOURNAL || '';
const releasePath = process.env.AGSCHED_DOC_EXEC_RELEASE || '';

function readControl() {
	if (!controlPath) return {};
	try {
		return JSON.parse(fs.readFileSync(controlPath, 'utf8'));
	} catch {
		return {};
	}
}

function journal(entry) {
	if (!journalPath) return;
	try {
		fs.appendFileSync(
			journalPath,
			`${JSON.stringify({ ts: new Date().toISOString(), persona, pid: process.pid, ...entry })}\n`,
		);
	} catch {
		// The acceptance log is best-effort; a full disk must not hide the run result.
	}
}

function versionText() {
	return persona === 'claude'
		? 'Claude Code 1.0.0 (document-execution)\n'
		: 'codex 0.1.0 (document-execution)\n';
}

if (process.argv.includes('--version') || process.argv.includes('-V') || process.argv.includes('-v')) {
	process.stdout.write(versionText());
	process.exit(0);
}

if (process.argv.includes('login') || process.argv.includes('auth')) {
	process.stdout.write(persona === 'claude' ? '{"loggedIn":true}\n' : 'Logged in\n');
	process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	process.stdout.write(`${versionText()}--effort low medium high xhigh max\n`);
	process.exit(0);
}

function taskKeyFrom(prompt) {
	const match = /DOC_EXEC_TASK:\s*([A-Za-z0-9._-]+)/.exec(prompt);
	return match?.[1] ?? '';
}

function phaseFrom(prompt) {
	// The review prompt also contains the words "输出格式". Only the wrapup
	// contract opens with the batch-close heading.
	if (prompt.includes('# 批次收口') || prompt.includes('本批任务已全部落地')) return 'wrapup';
	if (/DOC_EXEC_PHASE:\s*review/.test(prompt)) return 'review';
	if (/DOC_EXEC_PHASE:\s*bughunt/.test(prompt)) return 'bughunt';
	return 'implement';
}

function actionFor(prompt) {
	const control = readControl();
	const phase = phaseFrom(prompt);
	const task = taskKeyFrom(prompt);
	if (phase === 'review') return { phase, task, action: control.review || 'pass' };
	if (phase === 'wrapup') return { phase, task, action: control.wrapup || 'clean' };
	const tasks = control.tasks && typeof control.tasks === 'object' ? control.tasks : {};
	return { phase, task, action: tasks[task] || control.implement || 'ok' };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRelease(task) {
	const started = Date.now();
	while (Date.now() - started < 180000) {
		let text = '';
		try {
			text = releasePath && fs.existsSync(releasePath) ? fs.readFileSync(releasePath, 'utf8') : '';
		} catch {
			text = '';
		}
		if (text.includes('all') || (task && text.includes(task))) return;
		await sleep(100);
	}
	throw new Error(`release timed out for ${task || 'wrapup'}`);
}

function commitMarker(name, body, leaveUntracked) {
	fs.writeFileSync(name, body, 'utf8');
	const git = (args) => {
		try {
			return execFileSync(
				'git',
				['-c', 'user.name=Doc Exec', '-c', 'user.email=doc-exec@example.invalid', '-c', 'safe.directory=*', ...args],
				{ cwd: process.cwd(), encoding: 'utf8' },
			);
		} catch (error) {
			const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
			const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
			throw new Error(`git ${args.join(' ')} failed\n${stdout}\n${stderr}`);
		}
	};
	git(['add', '--', name]);
	git(['commit', '-m', body]);
	// The mechanical check diffs the worktree against its own HEAD. A committed file
	// alone looks empty, so the implement run leaves one untracked file until the
	// test removes it. A dirty worktree is also treated as not in HEAD.
	if (leaveUntracked) fs.writeFileSync('untracked-diff.txt', `${body}pending\n`, 'utf8');
}

function reviewText(action) {
	if (action === 'fail') return 'VERDICT: rework\n\nREWORK\n- R1 验收未通过\n';
	return 'VERDICT: pass\n';
}

function wrapupText(action, task) {
	if (action === 'garbage') return 'this is not a wrapup report\n';
	const tests = action === 'open' ? 'fail\n失败但未标明任务\n' : 'pass\n';
	const bugs =
		action === 'fixed' && task
			? `- B1 [S2] 涉及 ${task}: 说明过短 → 打开文件 → 少一行 → implemented.txt:1\n`
			: '- none\n';
	const fixed = action === 'fixed' ? '- B1 → 补了一行说明\n' : '- none\n';
	const verdict = action === 'fixed' ? 'fixed' : action === 'open' ? 'open' : 'clean';
	return [
		'## BATCH_SUMMARY',
		'本批按文档顺序自动执行验收。',
		'',
		'## TESTS',
		tests.trimEnd(),
		'',
		'## BUGS',
		bugs.trimEnd(),
		'',
		'## FIXED',
		fixed.trimEnd(),
		'',
		'## NOT_FIXED',
		'- none',
		'',
		'## SUSPECT',
		'- none',
		'',
		'## RECORD',
		`verdict: ${verdict}`,
		'',
		'## NEXT',
		'- none',
		'',
	].join('\n');
}

async function produce(prompt) {
	let plan = actionFor(prompt);
	journal({ phase: plan.phase, task: plan.task, action: plan.action, event: 'start' });
	if (plan.action === 'hold') {
		await waitForRelease(plan.task || 'wrapup');
		plan = actionFor(prompt);
		journal({ phase: plan.phase, task: plan.task, action: plan.action, event: 'released' });
	}
	if (plan.action === 'slow') await sleep(1500);
	if (plan.phase === 'implement' && plan.action !== 'fail' && plan.action !== 'no-change') {
		const control = readControl();
		if (control.implementCommit !== false) {
			const task = plan.task || 'task';
			commitMarker(`implemented-${task}.txt`, `implement ${task} ${Date.now()}\n`, true);
		}
	}
	if (plan.phase === 'wrapup' && plan.action !== 'fail' && plan.action !== 'garbage') {
		commitMarker(`wrapup-note-${Date.now()}.txt`, `wrapup ${plan.action} ${Date.now()}\n`, false);
	}
	let text = `implemented ${plan.task}\n`;
	if (plan.phase === 'review') text = reviewText(plan.action);
	if (plan.phase === 'wrapup') {
		text = plan.action === 'fail' ? 'not a wrapup report\n' : wrapupText(plan.action, plan.task);
	}
	const fail = plan.action === 'fail';
	journal({ phase: plan.phase, task: plan.task, action: plan.action, event: fail ? 'fail' : 'done' });
	return { text, fail };
}

function writeLine(value) {
	fs.writeSync(1, `${JSON.stringify(value)}\n`);
}

async function runCodex() {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	let working = null;
	rl.on('line', (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
		const method = msg.method;
		if (method === 'initialize') {
			writeLine({
				id: msg.id,
				result: { serverInfo: { name: 'document-execution-agent', version: '0.1.0' } },
			});
			return;
		}
		if (method === 'model/list') {
			writeLine({
				id: msg.id,
				result: {
					data: [
						{
							model: 'doc-exec',
							isDefault: true,
							supportedReasoningEfforts: ['low', 'medium', 'high', 'ultra'],
						},
					],
				},
			});
			return;
		}
		if (method === 'thread/start') {
			writeLine({ id: msg.id, result: { thread: { id: 'thread-doc-exec' } } });
			return;
		}
		if (method === 'turn/start') {
			const input = Array.isArray(msg.params?.input) ? msg.params.input : [];
			const prompt = input.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');
			writeLine({ id: msg.id, result: { turn: { id: 'turn-doc-exec', status: 'in_progress' } } });
			working = produce(prompt)
				.then(async ({ text, fail }) => {
					writeLine({ method: 'item/agentMessage/delta', params: { delta: text } });
					writeLine({
						method: 'item/completed',
						params: { item: { id: 'msg-doc-exec', type: 'agentMessage', text } },
					});
					writeLine({
						method: 'turn/completed',
						params: { threadId: 'thread-doc-exec', turn: { id: 'turn-doc-exec', status: fail ? 'failed' : 'completed' } },
					});
					await sleep(200);
					process.exit(fail ? 1 : 0);
				})
				.catch((error) => {
					journal({ event: 'error', message: String(error?.stack || error) });
					process.stderr.write(`${error?.stack || error}\n`);
					process.exit(1);
				});
			return;
		}
		writeLine({ id: msg.id, result: {} });
	});
	await new Promise((resolve) => rl.on('close', resolve));
	if (working) await working;
}

async function runClaude() {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	const lines = [];
	rl.on('line', (line) => lines.push(line));
	const started = Date.now();
	while (lines.length === 0 && Date.now() - started < 8000) await sleep(20);
	let prompt = '';
	for (const line of lines) {
		try {
			const msg = JSON.parse(line);
			const content = msg?.message?.content;
			if (Array.isArray(content)) {
				prompt = content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');
			}
		} catch {
			prompt = line;
		}
	}
	try {
		const { text, fail } = await produce(prompt);
		writeLine({
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text }] },
		});
		writeLine({ type: 'result', parent_tool_use_id: null, result: text, is_error: fail });
		await sleep(100);
		process.exit(fail ? 1 : 0);
	} catch (error) {
		journal({ event: 'error', message: String(error?.stack || error) });
		process.stderr.write(`${error?.stack || error}\n`);
		process.exit(1);
	}
}

function promptFromArgv() {
	const args = process.argv.slice(2);
	return (
		args.find((arg) => arg.includes('DOC_EXEC_') || arg.includes('批次收口') || arg.includes('BATCH_SUMMARY')) ??
		args.filter((arg) => !arg.startsWith('-') && arg.length > 20).at(-1) ??
		''
	);
}

async function runExec() {
	try {
		const { text, fail } = await produce(promptFromArgv());
		writeLine({ type: 'thread.started', thread_id: 'thread-doc-exec' });
		writeLine({ type: 'turn.started', turn_id: 'turn-doc-exec' });
		writeLine({ type: 'item.completed', item: { id: 'msg-doc-exec', type: 'agent_message', text } });
		writeLine({ method: 'item/agentMessage/delta', params: { delta: text } });
		writeLine({
			method: 'item/completed',
			params: { item: { id: 'msg-doc-exec', type: 'agentMessage', text } },
		});
		writeLine({ type: 'turn.completed', turn_id: 'turn-doc-exec' });
		writeLine({
			method: 'turn/completed',
			params: { turn: { id: 'turn-doc-exec', status: fail ? 'failed' : 'completed' } },
		});
		// Review and wrapup keep the raw stdout when no chunk is indexed. The
		// parsers only accept a verdict or a section heading as its own line.
		fs.writeSync(1, `${text.endsWith('\n') ? text : `${text}\n`}`);
		await sleep(1200);
		process.exit(fail ? 1 : 0);
	} catch (error) {
		journal({ event: 'error', message: String(error?.stack || error) });
		process.stderr.write(`${error?.stack || error}\n`);
		process.exit(1);
	}
}

const claudeMode = process.argv.includes('--print') || process.argv.includes('--output-format');
const execMode = process.argv.includes('exec');
(claudeMode ? runClaude() : execMode ? runExec() : runCodex()).catch((error) => {
	process.stderr.write(`${error?.stack || error}\n`);
	process.exit(1);
});
