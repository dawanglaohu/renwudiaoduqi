import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';

const currentDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(currentDir, '../..');
export const fixturesDir = join(repoRoot, 'e2e/fixtures');
const invocationDir = join(repoRoot, 'e2e/artifacts/document-execution', randomUUID());
export let artifactsDir = invocationDir;
let evidenceStarted = Date.now();

export function beginEvidence(name: string): void {
	artifactsDir = join(invocationDir, name.replace(/[^\w.-]+/g, '_').slice(0, 100));
	evidenceStarted = Date.now();
	mkdirSync(artifactsDir, { recursive: true });
	let head: string;
	try {
		head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (error) {
		const pointer = readFileSync(join(repoRoot, '.git'), 'utf8').trim().replace(/^gitdir: /, '');
		if (process.platform !== 'linux' || !/^[A-Za-z]:\//.test(pointer)) throw error;
		const gitDir = execFileSync('wslpath', ['-u', pointer], { encoding: 'utf8' }).trim();
		head = execFileSync('git', [`--git-dir=${gitDir}`, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	}
	writeFileSync(join(artifactsDir, 'invocation.json'), JSON.stringify({
		test: name, startedAt: new Date(evidenceStarted).toISOString(), platform: process.platform,
		head, sourceDigest: createHash('sha256').update([
			'e2e/document-execution.test.ts', 'e2e/helpers/document-execution-harness.ts',
			'e2e/fixtures/document-execution-agent.mjs', 'packages/daemon/src/service/dispatch.ts',
			'packages/daemon/src/service/review.ts',
		].map((path) => `${path}\n${readFileSync(join(repoRoot, path), 'utf8')}`).join('\n')).digest('hex'),
	}, null, 2));
}
const bootstrapPath = join(repoRoot, 'packages/daemon/bootstrap.mjs');
const agentSource = join(fixturesDir, 'document-execution-agent.mjs');

const require = createRequire(join(repoRoot, 'packages/daemon/package.json'));

export interface DocTaskSpec {
	readonly id: string;
	readonly hash: string;
	readonly deps?: readonly string[];
	readonly paths?: readonly string[];
	readonly title?: string;
	readonly ready?: boolean;
	readonly reasons?: readonly string[];
	readonly implement?: string;
	readonly review?: string;
	readonly accept?: string;
}

export interface RunningDaemon {
	readonly port: number;
	readonly dataDir: string;
	readonly controlPath: string;
	readonly journalPath: string;
	readonly releasePath: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	getStdout(): string;
	getStderr(): string;
	stop(options?: { readonly keepData?: boolean }): Promise<void>;
}

export interface DocumentApi {
	readonly token: string;
	get(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
	post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
	patch(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

function redact(text: string): string {
	return text
		.replace(/(\[daemon\]\s+Initial pairing code:\s*)[^\r\n\s]+/gi, '$1[REDACTED]')
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
		.replace(/("(?:token|deviceToken|code)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				const port = address.port;
				server.close(() => resolvePort(port));
			} else {
				reject(new Error('Failed to resolve port'));
			}
		});
	});
}

function windowsLauncher(): string {
	const cached = join(tmpdir(), 'agsched-doc-exec-launcher-cs.exe');
	if (existsSync(cached)) return cached;
	const sourceDir = mkdtempSync(join(tmpdir(), 'agsched-doc-exec-launcher-src-'));
	const source = join(sourceDir, 'Launcher.cs');
	writeFileSync(source, WINDOWS_LAUNCHER_CS, 'utf8');
	const compiler = join(
		process.env.WINDIR ?? 'C:\\Windows',
		'Microsoft.NET',
		'Framework64',
		'v4.0.30319',
		'csc.exe',
	);
	execFileSync(compiler, ['/nologo', '/optimize+', `/out:${cached}`, source], { stdio: 'inherit' });
	return cached;
}

const WINDOWS_LAUNCHER_CS = Buffer.from("dXNpbmcgU3lzdGVtOwp1c2luZyBTeXN0ZW0uRGlhZ25vc3RpY3M7CnVzaW5nIFN5c3RlbS5JTzsKdXNpbmcgU3lzdGVtLlRleHQ7CnVzaW5nIFN5c3RlbS5UaHJlYWRpbmc7CgpzZWFsZWQgY2xhc3MgTGF1bmNoZXIgewoJc3RhdGljIGludCBNYWluKHN0cmluZ1tdIGFyZ3MpIHsKCQlzdHJpbmcgZXhlID0gUHJvY2Vzcy5HZXRDdXJyZW50UHJvY2VzcygpLk1haW5Nb2R1bGUuRmlsZU5hbWU7CgkJc3RyaW5nIHN0ZW0gPSBQYXRoLkdldEZpbGVOYW1lV2l0aG91dEV4dGVuc2lvbihleGUpID8/ICIiOwoJCXN0cmluZyBwZXJzb25hID0gc3RlbS5JbmRleE9mKCJjbGF1ZGUiLCBTdHJpbmdDb21wYXJpc29uLk9yZGluYWxJZ25vcmVDYXNlKSA+PSAwID8gImNsYXVkZSIgOiAiY29kZXgiOwoJCXN0cmluZyBub2RlID0gRW52aXJvbm1lbnQuR2V0RW52aXJvbm1lbnRWYXJpYWJsZSgiQUdTQ0hFRF9ET0NfRVhFQ19OT0RFIik7CgkJc3RyaW5nIHNjcmlwdCA9IEVudmlyb25tZW50LkdldEVudmlyb25tZW50VmFyaWFibGUoIkFHU0NIRURfRE9DX0VYRUNfU0NSSVBUIik7CgkJaWYgKHN0cmluZy5Jc051bGxPckVtcHR5KG5vZGUpIHx8IHN0cmluZy5Jc051bGxPckVtcHR5KHNjcmlwdCkpIHJldHVybiAyOwoJCVByb2Nlc3NTdGFydEluZm8gcHNpID0gbmV3IFByb2Nlc3NTdGFydEluZm8oKTsKCQlwc2kuRmlsZU5hbWUgPSBub2RlOwoJCXBzaS5Bcmd1bWVudHMgPSBKb2luQXJncyhzY3JpcHQsIGFyZ3MpOwoJCXBzaS5Vc2VTaGVsbEV4ZWN1dGUgPSBmYWxzZTsKCQlwc2kuUmVkaXJlY3RTdGFuZGFyZE91dHB1dCA9IHRydWU7CgkJcHNpLkVudmlyb25tZW50VmFyaWFibGVzWyJBR1NDSEVEX0RPQ19FWEVDX1BFUlNPTkEiXSA9IHBlcnNvbmE7CgkJUHJvY2VzcyBjaGlsZCA9IFByb2Nlc3MuU3RhcnQocHNpKTsKCQlpZiAoY2hpbGQgPT0gbnVsbCkgcmV0dXJuIDI7CgkJVGhyZWFkIHB1bXAgPSBuZXcgVGhyZWFkKGRlbGVnYXRlKCkgewoJCQlTdHJlYW0gaW5wdXQgPSBjaGlsZC5TdGFuZGFyZE91dHB1dC5CYXNlU3RyZWFtOwoJCQlTdHJlYW0gb3V0cHV0ID0gQ29uc29sZS5PcGVuU3RhbmRhcmRPdXRwdXQoKTsKCQkJYnl0ZVtdIGJ1ZiA9IG5ldyBieXRlWzQwOTZdOwoJCQlpbnQgcmVhZDsKCQkJd2hpbGUgKChyZWFkID0gaW5wdXQuUmVhZChidWYsIDAsIGJ1Zi5MZW5ndGgpKSA+IDApIHsKCQkJCW91dHB1dC5Xcml0ZShidWYsIDAsIHJlYWQpOwoJCQkJb3V0cHV0LkZsdXNoKCk7CgkJCX0KCQl9KTsKCQlwdW1wLklzQmFja2dyb3VuZCA9IHRydWU7CgkJcHVtcC5TdGFydCgpOwoJCWNoaWxkLldhaXRGb3JFeGl0KCk7CgkJcHVtcC5Kb2luKCk7CgkJcmV0dXJuIGNoaWxkLkV4aXRDb2RlOwoJfQoKCXN0YXRpYyBzdHJpbmcgSm9pbkFyZ3Moc3RyaW5nIHNjcmlwdCwgc3RyaW5nW10gYXJncykgewoJCVN0cmluZ0J1aWxkZXIgYnVpbGRlciA9IG5ldyBTdHJpbmdCdWlsZGVyKCk7CgkJYnVpbGRlci5BcHBlbmQoUXVvdGUoc2NyaXB0KSk7CgkJZm9yIChpbnQgaSA9IDA7IGkgPCBhcmdzLkxlbmd0aDsgaSsrKSB7CgkJCWJ1aWxkZXIuQXBwZW5kKCcgJyk7CgkJCWJ1aWxkZXIuQXBwZW5kKFF1b3RlKGFyZ3NbaV0pKTsKCQl9CgkJcmV0dXJuIGJ1aWxkZXIuVG9TdHJpbmcoKTsKCX0KCglzdGF0aWMgc3RyaW5nIFF1b3RlKHN0cmluZyB2YWx1ZSkgewoJCWlmICh2YWx1ZS5MZW5ndGggPT0gMCkgcmV0dXJuICJcIlwiIjsKCQlpZiAodmFsdWUuSW5kZXhPZkFueShuZXcgY2hhcltdIHsgJyAnLCAnXHQnLCAnXG4nLCAnXHInLCAnIicgfSkgPCAwKSByZXR1cm4gdmFsdWU7CgkJU3RyaW5nQnVpbGRlciBidWlsZGVyID0gbmV3IFN0cmluZ0J1aWxkZXIoKTsKCQlidWlsZGVyLkFwcGVuZCgnIicpOwoJCWludCBzbGFzaGVzID0gMDsKCQlmb3IgKGludCBpID0gMDsgaSA8IHZhbHVlLkxlbmd0aDsgaSsrKSB7CgkJCWNoYXIgY2ggPSB2YWx1ZVtpXTsKCQkJaWYgKGNoID09ICdcXCcpIHsgc2xhc2hlcysrOyBjb250aW51ZTsgfQoJCQlpZiAoY2ggPT0gJyInKSB7CgkJCQlidWlsZGVyLkFwcGVuZCgnXFwnLCBzbGFzaGVzICogMiArIDEpOwoJCQkJYnVpbGRlci5BcHBlbmQoJyInKTsKCQkJCXNsYXNoZXMgPSAwOwoJCQkJY29udGludWU7CgkJCX0KCQkJaWYgKHNsYXNoZXMgPiAwKSB7IGJ1aWxkZXIuQXBwZW5kKCdcXCcsIHNsYXNoZXMpOyBzbGFzaGVzID0gMDsgfQoJCQlidWlsZGVyLkFwcGVuZChjaCk7CgkJfQoJCWlmIChzbGFzaGVzID4gMCkgYnVpbGRlci5BcHBlbmQoJ1xcJywgc2xhc2hlcyAqIDIpOwoJCWJ1aWxkZXIuQXBwZW5kKCciJyk7CgkJcmV0dXJuIGJ1aWxkZXIuVG9TdHJpbmcoKTsKCX0KfQo=", 'base64').toString('utf8');

function writeLauncher(dir: string, persona: 'codex' | 'claude', script = agentSource): string {
	mkdirSync(dir, { recursive: true });
	if (process.platform === 'win32') {
		const path = join(dir, `${persona}-agent.exe`);
		writeFileSync(path, readFileSync(windowsLauncher()));
		return path;
	}
	const path = join(dir, `${persona}-agent`);
	writeFileSync(
		path,
		`#!/bin/sh\nexport AGSCHED_DOC_EXEC_PERSONA=${persona}\nexec "${process.execPath}" "${script}" "$@"\n`,
		'utf8',
	);
	chmodSync(path, 0o755);
	return path;
}

export function writeControl(
	daemon: RunningDaemon,
	control: {
		readonly tasks?: Readonly<Record<string, string>>;
		readonly review?: string;
		readonly wrapup?: string;
		readonly implement?: string;
		readonly implementCommit?: boolean;
	},
): void {
	writeFileSync(daemon.controlPath, JSON.stringify(control), 'utf8');
}

export function releaseAgents(daemon: RunningDaemon, names: readonly string[]): void {
	writeFileSync(daemon.releasePath, `${names.join('\n')}\n`, 'utf8');
}

export function clearRelease(daemon: RunningDaemon): void {
	writeFileSync(daemon.releasePath, '', 'utf8');
}

export async function startDocumentDaemon(options?: {
	readonly agentScript?: string;
	readonly startupTimeoutMs?: number;
}): Promise<RunningDaemon> {
	const port = await freePort();
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-doc-exec-'));
	const controlPath = join(dataDir, 'control.json');
	const journalPath = join(dataDir, 'agent-journal.ndjson');
	const releasePath = join(dataDir, 'release.txt');
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');
	writeFileSync(controlPath, JSON.stringify({ review: 'pass', wrapup: 'clean' }), 'utf8');
	writeFileSync(journalPath, '', 'utf8');
	writeFileSync(releasePath, '', 'utf8');
	const codexPath = writeLauncher(join(dataDir, 'bin'), 'codex', options?.agentScript);
	const claudePath = writeLauncher(join(dataDir, 'bin'), 'claude', options?.agentScript);
	writeFileSync(
		join(dataDir, 'agents.json'),
		JSON.stringify(
			{
				schemaVersion: 1,
				overrides: {
					codex: { execPath: codexPath, maxConcurrency: 3 },
					claude: { execPath: claudePath, maxConcurrency: 2 },
				},
			},
			null,
			2,
		),
		'utf8',
	);
	const child = spawn(process.execPath, [bootstrapPath], {
		cwd: repoRoot,
		env: {
			...process.env,
			AGSCHED_PORT: String(port),
			AGSCHED_DATA_DIR: dataDir,
			AGSCHED_BIND: '127.0.0.1',
			AGSCHED_LOG_LEVEL: 'info',
			AGSCHED_DEV: '1',
			AGSCHED_DOC_EXEC_CONTROL: controlPath,
			AGSCHED_DOC_EXEC_JOURNAL: journalPath,
			AGSCHED_DOC_EXEC_RELEASE: releasePath,
			AGSCHED_DOC_EXEC_NODE: process.execPath,
			AGSCHED_DOC_EXEC_SCRIPT: options?.agentScript ?? agentSource,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return trackDaemon(child, { port, dataDir, controlPath, journalPath, releasePath, stdoutPath, stderrPath }, options?.startupTimeoutMs);
}

function trackDaemon(
	child: ChildProcess,
	paths: {
		port: number;
		dataDir: string;
		controlPath: string;
		journalPath: string;
		releasePath: string;
		stdoutPath: string;
		stderrPath: string;
	},
	startupTimeoutMs = 90000,
): Promise<RunningDaemon> {
	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk) => {
		stdout += chunk.toString();
		writeFileSync(paths.stdoutPath, redact(stdout), 'utf8');
	});
	child.stderr?.on('data', (chunk) => {
		stderr += chunk.toString();
		writeFileSync(paths.stderrPath, redact(stderr), 'utf8');
	});
	const exited = new Promise<void>((resolveExit) => {
		child.once('exit', () => resolveExit());
	});
	const daemon: RunningDaemon = {
		...paths,
		getStdout: () => redact(existsSync(paths.stdoutPath) ? readFileSync(paths.stdoutPath, 'utf8') : stdout),
		getStderr: () => redact(existsSync(paths.stderrPath) ? readFileSync(paths.stderrPath, 'utf8') : stderr),
		async stop(options) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM');
				const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
				await exited;
				clearTimeout(timer);
			}
			if (!options?.keepData) rmSync(paths.dataDir, { recursive: true, force: true });
		},
	};
	const deadline = Date.now() + startupTimeoutMs;
	return (async () => {
		while (Date.now() < deadline) {
			if (child.exitCode !== null) break;
			try {
				const response = await fetch(`http://127.0.0.1:${paths.port}/api/v1/health`);
				if (response.ok) return daemon;
			} catch {
				// The listener is still coming up.
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		await captureFailure(null, daemon, 'startup');
		await daemon.stop();
		throw new Error('Document-execution daemon did not become healthy');
	})();
}

export async function claimAdmin(daemon: RunningDaemon): Promise<string> {
	const codePath = join(daemon.dataDir, 'pairing-code.txt');
	let code = '';
	for (let attempt = 0; attempt < 40 && code.length === 0; attempt += 1) {
		if (existsSync(codePath)) code = readFileSync(codePath, 'utf8').trim();
		if (!code) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
	}
	if (!/^[A-Za-z0-9]{6}$/.test(code)) throw new Error('Pairing code was not issued');
	const response = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/claim`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ code, deviceName: 'Document execution harness' }),
	});
	const body = (await response.json()) as { token?: string };
	if (!response.ok || !body.token) throw new Error(`Pairing claim failed: ${response.status}`);
	return body.token;
}

export function apiFor(daemon: RunningDaemon, token: string): DocumentApi {
	const send = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: Record<string, unknown> = {};
		if (text) {
			try {
				parsed = JSON.parse(text) as Record<string, unknown>;
			} catch {
				parsed = { raw: text };
			}
		}
		return { status: response.status, body: parsed };
	};
	return {
		token,
		get: (path) => send('GET', path),
		post: (path, body) => send('POST', path, body),
		patch: (path, body) => send('PATCH', path, body),
	};
}

export async function openBrowser(): Promise<Browser> {
	return chromium.launch({ headless: true });
}

export async function pairPage(page: Page, daemon: RunningDaemon, adminToken: string): Promise<void> {
	const codeResponse = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/code`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${adminToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({}),
	});
	const codeBody = (await codeResponse.json()) as { code?: string };
	if (!codeBody.code) throw new Error('Browser pairing code was not issued');
	await page.goto(`http://127.0.0.1:${daemon.port}/#/pair`, { waitUntil: 'domcontentloaded' });
	await page.locator('[data-testid="pairing-code-input"]').fill(codeBody.code);
	const manual = page.getByRole('button', { name: /手填地址/ });
	if (await manual.isVisible().catch(() => false)) {
		await manual.click();
		await page.locator('[data-testid="manual-host-input"]').fill(`127.0.0.1:${daemon.port}`);
	}
	await page.locator('[data-testid="pairing-submit-button"]').click();
	await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 20000 });
}

export function renderDocs(tasks: readonly DocTaskSpec[], project = '文档顺序自动执行验收'): string {
	const contracts: Record<string, unknown> = {};
	const readiness: Record<string, unknown> = {};
	const paths: Record<string, readonly string[]> = {};
	const dispatch: Record<string, unknown> = {};
	for (const task of tasks) {
		const effective = task.paths ?? [`src/${task.id.toLowerCase()}.ts`];
		contracts[task.id] = { hash: task.hash, effectivePaths: effective };
		readiness[task.id] = {
			ready: task.ready !== false,
			contractHash: task.hash,
			reasons: task.reasons ?? [],
		};
		paths[task.id] = effective;
		dispatch[task.id] = {
			contractHash: task.hash,
			implementation:
				task.implement ??
				`DOC_EXEC_PHASE: implement\nDOC_EXEC_TASK: ${task.id}\n实现 ${task.id}`,
			review: task.review ?? `DOC_EXEC_PHASE: review\nDOC_EXEC_TASK: ${task.id}\n审查 ${task.id}`,
		};
	}
	return `window.DOCS = ${JSON.stringify({
		schemaVersion: 1,
		project,
		pres: { handoff: { repo: '.', mainBranch: 'main', branchPrefix: 'task/' } },
		handoff: { version: '1.1.0', schemaVersion: 1, contracts, readiness, effectivePaths: paths },
		data: {
			tasks: tasks.map((task) => ({
				id: task.id,
				title: task.title ?? task.id,
				module: 'M1',
				deps: task.deps ?? [],
				accept: task.accept ?? `1) ${task.id} 验收`,
				est: 1,
			})),
		},
		dispatch,
	})};`;
}

export function createRepo(prefix: string): { root: string; repo: string } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const repo = join(root, 'project');
	mkdirSync(repo);
	git(repo, ['init']);
	git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
	git(repo, ['config', 'user.name', 'Doc Exec']);
	git(repo, ['config', 'user.email', 'doc-exec@example.invalid']);
	// Fixture bytes remain identical in the main checkout and every task worktree.
	git(repo, ['config', 'core.autocrlf', 'false']);
	return { root, repo };
}

export function commitDocs(repo: string, fileName: string, contents: string): string {
	const path = join(repo, fileName);
	writeFileSync(path, contents, 'utf8');
	git(repo, ['add', '--', fileName]);
	const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
	if (status.trim()) git(repo, ['commit', '-m', `docs ${fileName}`]);
	return path;
}

export function git(repo: string, args: readonly string[]): string {
	try {
		return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
	} catch (error) {
		const stdout = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
		const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : '';
		throw new Error(`git ${args.join(' ')} failed\n${stdout}\n${stderr}`);
	}
}

export function mergeBranch(repo: string, branch: string): void {
	const sha = git(repo, ['rev-parse', branch]).trim();
	git(repo, ['merge', '--no-ff', '--no-edit', '-m', `land ${branch}`, sha]);
}

export async function importThroughPage(page: Page, docsPath: string, repoPath: string): Promise<void> {
	const docs = page.locator('[data-testid="import-doc-path"]');
	await docs.waitFor({ state: 'visible', timeout: 20000 });
	await docs.fill(docsPath);
	await page.locator('[data-testid="import-repo-path"]').fill(repoPath);
	await page.locator('[data-action="import-document"]').click();
	await page
		.locator('[data-testid="document-execution-state"]')
		.waitFor({ state: 'visible', timeout: 20000 });
}

export async function executionOf(api: DocumentApi, docId: string): Promise<Record<string, unknown>> {
	const response = await api.get(`/api/v1/documents/${docId}/execution`);
	const execution = response.body.execution;
	if (response.status !== 200 || !execution || typeof execution !== 'object') {
		throw new Error(`Execution read failed: ${response.status} ${JSON.stringify(response.body)}`);
	}
	return execution as Record<string, unknown>;
}

export async function waitFor(
	label: string,
	predicate: () => Promise<boolean>,
	timeoutMs = 30000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

export interface ListedRun {
	readonly id: string;
	readonly taskId: string | null;
	readonly kind: string;
	readonly state: string;
	readonly attemptNo: number;
	readonly agentId: string;
	readonly modelName?: string | null;
	readonly reportedModel?: string | null;
	readonly effortVendor?: string | null;
	readonly effort?: { vendor?: string; tier?: string } | null;
	readonly branchName: string | null;
	readonly worktreePath: string | null;
	readonly pid?: number | null;
	readonly assignmentSource?: string | null;
	readonly batchId?: string | null;
	readonly parentRunId?: string | null;
	readonly snapshotId?: string;
	readonly reviewVerdict?: string | null;
	readonly exitCode?: number | null;
	readonly effortTier?: string | null;
}

export async function listRuns(api: DocumentApi): Promise<ListedRun[]> {
	const response = await api.get('/api/v1/runs');
	const runs = response.body.runs;
	if (!Array.isArray(runs)) return [];
	return runs as ListedRun[];
}

export async function configureAutoPipeline(api: DocumentApi): Promise<void> {
	const gates = await api.patch('/api/v1/settings/gates', {
		dispatch: 'auto',
		review: 'auto',
		landing: 'auto',
	});
	if (gates.status !== 200) throw new Error(`Gate settings failed: ${JSON.stringify(gates.body)}`);
	const current = await api.get('/api/v1/settings/pipeline');
	const pipeline = current.body.pipeline as Record<string, unknown> | undefined;
	const updated = await api.patch('/api/v1/settings/pipeline', {
		bughunt: 0,
		wrapupMode: 'auto',
		reviewOverride: pipeline?.reviewOverride ?? null,
		wrapupAssignment: pipeline?.wrapupAssignment ?? { mode: 'follow' },
	});
	if (updated.status !== 200) throw new Error(`Pipeline settings failed: ${JSON.stringify(updated.body)}`);
}

export async function setLaneCount(api: DocumentApi, docId: string, laneCount: number): Promise<void> {
	const response = await api.patch(`/api/v1/documents/${docId}/settings`, { laneCount });
	if (response.status !== 200) throw new Error(`Lane update failed: ${JSON.stringify(response.body)}`);
}

export function readPlan(dataDir: string, docId: string): Array<Record<string, unknown>> {
	const Database = require('better-sqlite3') as new (
		path: string,
		options: { readonly: boolean; fileMustExist: boolean },
	) => {
		prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
		close(): void;
	};
	const db = new Database(join(dataDir, 'app.db'), { readonly: true, fileMustExist: true });
	try {
		const row = db.prepare('SELECT plan_json FROM document_executions WHERE doc_id = ?').get(docId) as
			| { plan_json?: string }
			| undefined;
		return JSON.parse(row?.plan_json || '[]') as Array<Record<string, unknown>>;
	} finally {
		db.close();
	}
}

export function readWrapupRows(dataDir: string, batchId: string): Array<Record<string, unknown>> {
	const Database = require('better-sqlite3') as new (
		path: string,
		options: { readonly: boolean; fileMustExist: boolean },
	) => {
		prepare(sql: string): { all(...args: unknown[]): unknown[] };
		close(): void;
	};
	const db = new Database(join(dataDir, 'app.db'), { readonly: true, fileMustExist: true });
	try {
		return db
			.prepare(
				'SELECT tasks_json, verdict, round, run_id FROM batch_wrapups WHERE batch_id = ? ORDER BY round',
			)
			.all(batchId) as Array<Record<string, unknown>>;
	} finally {
		db.close();
	}
}

export function readSnapshotInput(dataDir: string, runId: string): Record<string, unknown> | null {
	const Database = require('better-sqlite3') as new (
		path: string,
		options: { readonly: boolean; fileMustExist: boolean },
	) => {
		prepare(sql: string): { get(...args: unknown[]): unknown };
		close(): void;
	};
	const db = new Database(join(dataDir, 'app.db'), { readonly: true, fileMustExist: true });
	try {
		const row = db
			.prepare(
				`SELECT s.input_text AS input_text, s.contract_hash AS contract_hash
				 FROM runs r JOIN dispatch_snapshots s ON s.id = r.snapshot_id WHERE r.id = ?`,
			)
			.get(runId) as { input_text?: string; contract_hash?: string } | undefined;
		if (!row?.input_text) return null;
		const parsed = JSON.parse(row.input_text) as Record<string, unknown>;
		return { ...parsed, contractHash: row.contract_hash };
	} finally {
		db.close();
	}
}

export function readResources(dataDir: string, docId: string): Record<string, unknown> {
	const Database = require('better-sqlite3');
	const db = new Database(join(dataDir, 'app.db'), { readonly: true, fileMustExist: true });
	try {
		return {
			executionCount: db.prepare('SELECT COUNT(*) AS count FROM document_executions WHERE doc_id=?').get(docId).count,
			runs: db.prepare('SELECT r.id, r.attempt_no, r.snapshot_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.doc_id=? AND r.kind=\'implement\' ORDER BY r.id').all(docId),
			snapshots: db.prepare('SELECT s.id FROM dispatch_snapshots s JOIN tasks t ON t.id=s.task_id WHERE t.doc_id=? ORDER BY s.id').all(docId),
			lanes: db.prepare('SELECT id, lane_no FROM tasks WHERE doc_id=? ORDER BY id').all(docId),
		};
	} finally { db.close(); }
}

export function readRunSnapshot(dataDir: string, runId: string): Record<string, unknown> {
	const Database = require('better-sqlite3');
	const db = new Database(join(dataDir, 'app.db'), { readonly: true, fileMustExist: true });
	try {
		const row = db.prepare('SELECT s.* FROM dispatch_snapshots s JOIN runs r ON r.snapshot_id=s.id WHERE r.id=?').get(runId);
		if (!row) throw new Error(`Run snapshot is missing: ${runId}`);
		return { ...row, assignment: JSON.parse(row.assignment_json ?? 'null'), launch: JSON.parse(row.launch_spec_json ?? '{}') };
	} finally { db.close(); }
}

/** Send a real TCP request, retain no response, and disconnect after independent state observation. */
export async function requestWithoutResponse(daemon: RunningDaemon, api: DocumentApi, path: string, body: unknown): Promise<() => void> {
	const payload = JSON.stringify(body);
	const socket = net.createConnection({ host: '127.0.0.1', port: daemon.port });
	socket.pause();
	await new Promise<void>((resolveConnected, reject) => {
		socket.once('error', reject);
		socket.once('connect', () => {
			socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${daemon.port}\r\nAuthorization: Bearer ${api.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`, () => resolveConnected());
		});
	});
	return () => socket.destroy();
}

export async function captureFailure(page: Page | null, daemon: RunningDaemon | null, name: string): Promise<void> {
	mkdirSync(artifactsDir, { recursive: true });
	const dir = join(artifactsDir, name);
	mkdirSync(dir, { recursive: true });
	if (page) {
		await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true }).catch(() => undefined);
		const dom = await page.content().catch(() => '');
		writeFileSync(join(dir, 'dom.html'), redact(dom), 'utf8');
	}
	writeFileSync(join(dir, 'daemon.stdout.log'), daemon?.getStdout() ?? '', 'utf8');
	writeFileSync(join(dir, 'daemon.stderr.log'), daemon?.getStderr() ?? '', 'utf8');
	if (daemon) {
		if (existsSync(daemon.journalPath)) {
			writeFileSync(join(dir, 'agent-journal.ndjson'), readFileSync(daemon.journalPath, 'utf8'), 'utf8');
		}
		copyNamed(daemon.dataDir, dir, 'events.ndjson');
		copyNamed(daemon.dataDir, dir, 'raw.log');
	}
	const required = ['daemon.stdout.log', 'daemon.stderr.log', ...(page ? ['failure.png', 'dom.html'] : [])];
	const files = required.map((file) => {
		const path = join(dir, file);
		if (!existsSync(path) || statSync(path).mtimeMs < evidenceStarted) {
			throw new Error(`Current invocation is missing failure evidence: ${path}`);
		}
		return { file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
	});
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
		startedAt: new Date(evidenceStarted).toISOString(), capturedAt: new Date().toISOString(),
		browserStarted: page !== null, files,
	}, null, 2));
}

function copyNamed(source: string, dest: string, name: string): void {
	if (!existsSync(source)) return;
	for (const entry of readdirSync(source)) {
		const path = join(source, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) copyNamed(path, dest, name);
		else if (entry === name) writeFileSync(join(dest, `${entry}-${stat.ino}`), redact(readFileSync(path, 'utf8')));
	}
}

export async function selectVendorEffort(page: Page): Promise<void> {
	const picker = page.locator(
		'[data-testid="document-execution"] [data-testid="effort-picker"] [data-testid="grouped-select-trigger"]',
	);
	await picker.waitFor({ state: 'visible', timeout: 15000 });
	await picker.click();
	const option = page.locator('[data-testid="select-option-vendor:ultra"]');
	await option.waitFor({ state: 'visible', timeout: 10000 });
	await option.click();
}

export async function chooseAgent(page: Page, agentId: string): Promise<void> {
	await page.locator('[data-testid="document-default-agent"]').selectOption(agentId);
}
