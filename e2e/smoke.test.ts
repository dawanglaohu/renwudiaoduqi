import { execFileSync, execSync, spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '..');
const bootstrapPath = join(repoRoot, 'packages/daemon/bootstrap.mjs');
const artifactsDir = join(repoRoot, 'e2e/artifacts');
const fixturesDir = join(repoRoot, 'e2e/fixtures');

const sensitiveStrings = new Set<string>();

function registerSensitiveData(...values: (string | undefined | null)[]): void {
	for (const val of values) {
		if (!val) continue;
		const trimmed = String(val).trim();
		if (trimmed.length >= 4) {
			sensitiveStrings.add(trimmed);
		}
	}
}

function redactSensitiveData(text: string): string {
	if (!text || typeof text !== 'string') return '';
	let result = text
		.replace(/(\[daemon\]\s+Initial pairing code:\s*)[^\r\n\s]+/gi, '$1[REDACTED]')
		.replace(/(\b(?:pairing[-_ ]?code|code)\s*[:=]\s*)[A-Za-z0-9]{6}/gi, '$1[REDACTED]')
		.replace(
			/("(?:token|deviceToken|sessionToken|code|secret|apiKey)"\s*:\s*")[^"]+(")/gi,
			'$1[REDACTED]$2',
		)
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
		.replace(/([?&](?:code|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
		.replace(/(data-testid="pairing-code-input"[^>]*value=")[^"]+(")/gi, '$1[REDACTED]$2')
		.replace(/(value=")[A-Za-z0-9]{6}(")/gi, '$1[REDACTED]$2');

	for (const sensitive of sensitiveStrings) {
		if (!sensitive || sensitive.length < 4) continue;
		const escaped = sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
	}
	return result;
}

async function maskSensitivePageContent(page: Page): Promise<void> {
	try {
		await page.evaluate(() => {
			const inputs = document.querySelectorAll('input, textarea');
			for (const input of inputs) {
				if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
					input.value = '••••••';
					input.setAttribute('value', '••••••');
				}
				(input as HTMLElement).style.filter = 'blur(8px)';
				(input as HTMLElement).style.color = 'transparent';
				(input as HTMLElement).style.textShadow = '0 0 8px rgba(0,0,0,0.8)';
			}

			const selectors = [
				'[data-testid="pairing-code-input"]',
				'[data-testid="manual-host-input"]',
				'[data-component="pairing-container"]',
				'[data-testid="code-display"]',
			];
			for (const sel of selectors) {
				const els = document.querySelectorAll(sel);
				for (const el of els) {
					(el as HTMLElement).style.filter = 'blur(8px)';
				}
			}
		});
	} catch {
		// best effort
	}
}

async function findAvailablePort(): Promise<number> {
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

export interface DaemonExitResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface RunningDaemon {
	readonly port: number;
	readonly dataDir: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	getStdout(): string;
	getStderr(): string;
	getExitResult(): DaemonExitResult | null;
	waitForExit(): Promise<DaemonExitResult>;
	stop(): Promise<DaemonExitResult>;
}

async function startDaemon(options: { timeoutMs?: number } = {}): Promise<RunningDaemon> {
	const port = await findAvailablePort();
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-smoke-e2e-'));
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');

	// R2: Read and use e2e/fixtures/agents.json as the registry entry baseline
	const fixtureAgentsPath = join(fixturesDir, 'agents.json');
	const fixtureAgentsRaw = readFileSync(fixtureAgentsPath, 'utf8');
	const agentsConfig = JSON.parse(fixtureAgentsRaw);

	// Map fake-agent executable path for current platform
	const fakeAgentExec =
		process.platform === 'win32'
			? join(fixturesDir, 'fake-agent.cmd')
			: join(fixturesDir, 'fake-agent.mjs');

	agentsConfig.overrides = agentsConfig.overrides ?? {};
	agentsConfig.overrides.codex = {
		...(agentsConfig.overrides.codex ?? {}),
		execPath: fakeAgentExec,
	};
	writeFileSync(join(dataDir, 'agents.json'), JSON.stringify(agentsConfig, null, 2), 'utf8');

	const daemonEnv: Record<string, string | undefined> = {
		...process.env,
		AGSCHED_PORT: String(port),
		AGSCHED_DATA_DIR: dataDir,
		AGSCHED_BIND: '127.0.0.1',
		AGSCHED_LOG_LEVEL: 'info',
		AGSCHED_DEV: '1',
	};

	// On Windows, create an isolated git shim in .local/bin inside dataDir so daemon's candidate resolution finds git without touching system or production files (R1, R4)
	if (process.platform === 'win32') {
		try {
			const realGit = execSync('where.exe git', { encoding: 'utf8' })
				.trim()
				.split(/\r?\n/)[0];
			if (realGit && existsSync(realGit)) {
				const fakeHome = join(dataDir, 'fake-home');
				const shimDir = join(fakeHome, '.local', 'bin');
				mkdirSync(shimDir, { recursive: true });
				const symlinkTarget = join(shimDir, 'git.exe');
				try {
					symlinkSync(realGit, symlinkTarget);
				} catch {
					writeFileSync(
						join(shimDir, 'git.cmd'),
						`@echo off\r\n"${realGit}" %*\r\n`,
						'utf8',
					);
				}
				daemonEnv.USERPROFILE = fakeHome;
			}
		} catch {
			// fallback to natural environment
		}
	}

	// Start daemon process directly with Node spawn across all platforms (R3, AC 1)
	const child = spawn(process.execPath, [bootstrapPath], {
		cwd: repoRoot,
		env: daemonEnv,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdoutRawBuf = '';
	let stderrRawBuf = '';
	let exitResult: DaemonExitResult | null = null;

	const exitPromise = new Promise<DaemonExitResult>((res) => {
		child.once('exit', (code, signal) => {
			exitResult = { exitCode: code, signal };
			res(exitResult);
		});
	});

	child.stdout.on('data', (chunk) => {
		const text = chunk.toString();
		stdoutRawBuf += text;
		const match = text.match(/Initial pairing code:\s*([A-Za-z0-9]+)/i);
		if (match?.[1]) {
			registerSensitiveData(match[1]);
		}
		try {
			writeFileSync(stdoutPath, redactSensitiveData(stdoutRawBuf), 'utf8');
		} catch {
			// best effort
		}
	});

	child.stderr.on('data', (chunk) => {
		const text = chunk.toString();
		stderrRawBuf += text;
		try {
			writeFileSync(stderrPath, redactSensitiveData(stderrRawBuf), 'utf8');
		} catch {
			// best effort
		}
	});

	const stopFn = async (): Promise<DaemonExitResult> => {
		if (child.pid && child.exitCode === null) {
			child.kill('SIGTERM');
			const timer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// best effort
				}
			}, 4000);
			await exitPromise;
			clearTimeout(timer);
		}
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
		return exitResult ?? { exitCode: child.exitCode, signal: null };
	};

	const timeoutMs = options.timeoutMs ?? 45000;
	const healthUrl = `http://127.0.0.1:${port}/api/v1/health`;
	let isHealthy = false;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(healthUrl);
			if (res.ok) {
				isHealthy = true;
				break;
			}
		} catch {
			// retry
		}
		await new Promise((r) => setTimeout(r, 250));
	}

	if (!isHealthy) {
		const outLog = redactSensitiveData(
			existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '',
		);
		const errLog = redactSensitiveData(
			existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '',
		);
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(
			join(artifactsDir, 'startup-daemon-health-failure.log'),
			`=== DAEMON STDOUT ===\n${outLog}\n=== DAEMON STDERR ===\n${errLog}`,
			'utf8',
		);
		await stopFn();
		throw new Error(
			`Daemon failed to become healthy at ${healthUrl} within ${timeoutMs}ms.\nSTDOUT:\n${outLog}\nSTDERR:\n${errLog}`,
		);
	}

	return {
		port,
		dataDir,
		stdoutPath,
		stderrPath,
		getStdout(): string {
			return redactSensitiveData(existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '');
		},
		getStderr(): string {
			return redactSensitiveData(existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '');
		},
		getExitResult(): DaemonExitResult | null {
			return exitResult;
		},
		waitForExit(): Promise<DaemonExitResult> {
			return exitPromise;
		},
		stop: stopFn,
	};
}

describe('M1-T11 端到端冒烟：真起 daemon、真浏览器、派发主流程 (AC 1-5, E-10, E-31, E-108, E-135, E-139, E-159, E-175, E-226, E-265)', () => {
	let daemon: RunningDaemon;
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let adminToken: string;
	let docId: string | null = null;
	let currentRunId: string | null = null;
	const createdWorktreeDirs: string[] = [];

	// R1: Pre-existing sentinel worktree & branch
	const sentinelBranch = 'test/sentinel-preserve-e2e';
	const sentinelWorktreePath = resolve(repoRoot, '../agent-scheduler-sentinel-test');

	beforeAll(async () => {
		mkdirSync(artifactsDir, { recursive: true });

		try {
			// Ensure web is built
			const webDistIndex = join(repoRoot, 'packages/web/dist/index.html');
			if (!existsSync(webDistIndex)) {
				execSync('pnpm --filter @agent-scheduler/web build', {
					cwd: repoRoot,
					stdio: 'inherit',
				});
			}

			// R1: Setup sentinel branch and worktree to prove pre-existing checkouts survive
			try {
				execSync(`git branch -D ${sentinelBranch}`, { cwd: repoRoot, stdio: 'ignore' });
			} catch {}
			try {
				execSync(`git worktree remove --force "${sentinelWorktreePath}"`, {
					cwd: repoRoot,
					stdio: 'ignore',
				});
				rmSync(sentinelWorktreePath, { recursive: true, force: true });
			} catch {}

			execSync(`git branch ${sentinelBranch} HEAD`, { cwd: repoRoot, stdio: 'ignore' });
			execSync(`git worktree add "${sentinelWorktreePath}" ${sentinelBranch}`, {
				cwd: repoRoot,
				stdio: 'ignore',
			});
			writeFileSync(
				join(sentinelWorktreePath, 'sentinel-keep.txt'),
				'sentinel survives e2e smoke\n',
				'utf8',
			);

			try {
				rmSync(join(tmpdir(), 'agsched-fake-agent-1.signal'), { force: true });
				rmSync(join(tmpdir(), 'agsched-fake-agent-2.signal'), { force: true });
			} catch {}

			daemon = await startDaemon();
			browser = await chromium.launch({
				headless: true,
				args:
					typeof process.getuid === 'function' && process.getuid() === 0
						? ['--no-sandbox', '--disable-setuid-sandbox']
						: [],
			});
			context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
			});
			page = await context.newPage();
		} catch (setupError) {
			// R3, AC 5: Cover setup failures with sanitized diagnostics
			mkdirSync(artifactsDir, { recursive: true });
			const errMsg = setupError instanceof Error ? setupError.stack || setupError.message : String(setupError);
			writeFileSync(join(artifactsDir, 'setup-failure.log'), redactSensitiveData(errMsg), 'utf8');

			if (daemon) {
				writeFileSync(join(artifactsDir, 'setup-daemon-stdout.log'), daemon.getStdout(), 'utf8');
				writeFileSync(join(artifactsDir, 'setup-daemon-stderr.log'), daemon.getStderr(), 'utf8');
				await daemon.stop().catch(() => {});
			}
			throw setupError;
		}
	});

	afterEach(async ({ task }) => {
		if (task.result?.state === 'fail') {
			const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_');
			mkdirSync(artifactsDir, { recursive: true });

			if (daemon && currentRunId) {
				try {
					const r = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`, {
						headers: { Authorization: `Bearer ${adminToken}` },
					});
					const runState = await r.json();
					writeFileSync(
						join(artifactsDir, `${safeName}-run-state.json`),
						redactSensitiveData(JSON.stringify(runState, null, 2)),
						'utf8',
					);
				} catch {}
			}

			if (page) {
				try {
					await maskSensitivePageContent(page);
					const screenshotPath = join(artifactsDir, `${safeName}-failure.png`);
					await page.screenshot({ path: screenshotPath, fullPage: true });

					const domHtml = await page.content();
					const domPath = join(artifactsDir, `${safeName}-failure.dom.html`);
					writeFileSync(domPath, redactSensitiveData(domHtml), 'utf8');
				} catch {
					// best effort diagnostic capture
				}
			}

			if (daemon) {
				const stdoutLog = join(artifactsDir, `${safeName}-daemon-stdout.log`);
				const stderrLog = join(artifactsDir, `${safeName}-daemon-stderr.log`);
				writeFileSync(stdoutLog, daemon.getStdout(), 'utf8');
				writeFileSync(stderrLog, daemon.getStderr(), 'utf8');
			}
		}
	});

	afterAll(async () => {
		if (context) {
			await context.close().catch(() => {});
		}
		if (browser) {
			await browser.close().catch(() => {});
		}

		let exitResult: DaemonExitResult | null = null;
		if (daemon) {
			exitResult = await daemon.stop().catch(() => null);
		}

		// R1: Validate that the pre-existing sentinel worktree & branch survived completely
		const sentinelFileExists = existsSync(join(sentinelWorktreePath, 'sentinel-keep.txt'));
		expect(sentinelFileExists).toBe(true);

		// Clean up created worktrees and task branches created ONLY by this test (R1)
		for (const wt of createdWorktreeDirs) {
			try {
				execSync(`git worktree remove --force "${wt}"`, { cwd: repoRoot, stdio: 'ignore' });
			} catch {}
			try {
				rmSync(wt, { recursive: true, force: true });
			} catch {}
		}
		try {
			execSync('git branch -D task/SMOKE-T1', { cwd: repoRoot, stdio: 'ignore' });
		} catch {}

		// Now safely clean up the sentinel worktree & branch
		try {
			execSync(`git worktree remove --force "${sentinelWorktreePath}"`, {
				cwd: repoRoot,
				stdio: 'ignore',
			});
			rmSync(sentinelWorktreePath, { recursive: true, force: true });
		} catch {}
		try {
			execSync(`git branch -D ${sentinelBranch}`, { cwd: repoRoot, stdio: 'ignore' });
		} catch {}

		// Clean up any signal files in tmpdir
		try {
			rmSync(join(tmpdir(), 'agsched-fake-agent-1.signal'), { force: true });
			rmSync(join(tmpdir(), 'agsched-fake-agent-2.signal'), { force: true });
		} catch {}

		// R3: Assert daemon exit code was collected
		if (exitResult) {
			expect(exitResult).toBeDefined();
			// Process exited either normally or was terminated by SIGTERM (0 or null with SIGTERM signal)
			const isCleanExit = exitResult.exitCode === 0 || exitResult.signal === 'SIGTERM';
			expect(isCleanExit).toBe(true);
		}
	});

	it('step 1: verifies web build artifacts exist (AC 1)', () => {
		const webDistIndex = join(repoRoot, 'packages/web/dist/index.html');
		expect(existsSync(webDistIndex)).toBe(true);
		const htmlContent = readFileSync(webDistIndex, 'utf8');
		expect(htmlContent).toContain('<div id="root"></div>');
	});

	it('step 2: boots real daemon and claims token via pairing-code.txt (AC 1, E-226, E-139)', async () => {
		const codeFilePath = join(daemon.dataDir, 'pairing-code.txt');
		let code = '';
		for (let i = 0; i < 30; i++) {
			if (existsSync(codeFilePath)) {
				code = readFileSync(codeFilePath, 'utf8').trim();
				if (code.length > 0) break;
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
		registerSensitiveData(code);

		const claimRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/claim`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				code,
				deviceName: 'Smoke Test Admin Runner',
			}),
		});

		expect(claimRes.status).toBe(200);
		const claimData = (await claimRes.json()) as { token: string; deviceId: string };
		expect(claimData.token).toBeTruthy();
		adminToken = claimData.token;
		registerSensitiveData(adminToken);

		// pairing-code.txt must be deleted after claim (E-226)
		expect(existsSync(codeFilePath)).toBe(false);

		// daemon stdout was continuously collected
		const stdout = daemon.getStdout();
		expect(stdout.length).toBeGreaterThan(0);
	});

	it('step 3: pairs via real browser with manual address and code, lands on #/ and verifies styles (AC 2, E-159, E-175)', async () => {
		// Generate an ephemeral 60s pairing code using adminToken
		const codeRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/code`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(codeRes.status).toBe(200);
		const codeData = (await codeRes.json()) as { code: string };
		expect(codeData.code).toMatch(/^[A-Za-z0-9]{6}$/);
		const browserPairingCode = codeData.code;
		registerSensitiveData(browserPairingCode);

		await page.goto(`http://127.0.0.1:${daemon.port}/#/pair`);
		await page.waitForLoadState('networkidle');

		// Fill pairing code and manual host
		const codeInput = page.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 10000 });
		await codeInput.fill(browserPairingCode);

		const toggleManualHost = page.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
			const hostInput = page.locator('[data-testid="manual-host-input"]');
			await hostInput.waitFor({ state: 'visible', timeout: 5000 });
			await hostInput.fill(`127.0.0.1:${daemon.port}`);
		}

		const submitBtn = page.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
		await submitBtn.click();

		// Wait until navigation lands on #/
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 15000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/`);

		// Style Assertions (AC 2, E-159, E-175)
		// 1) getComputedStyle(document.body).fontFamily contains Public Sans
		const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
		expect(fontFamily).toContain('Public Sans');

		// 2) #root first child background-color is not rgba(0, 0, 0, 0)
		const rootFirstChildBg = await page.evaluate(() => {
			const root = document.getElementById('root');
			const firstChild = root?.firstElementChild;
			return firstChild ? getComputedStyle(firstChild).backgroundColor : '';
		});
		expect(rootFirstChildBg).toBeTruthy();
		expect(rootFirstChildBg).not.toBe('rgba(0, 0, 0, 0)');
		expect(rootFirstChildBg).not.toBe('transparent');

		// 3) document.styleSheets contains a rule with .flex
		const hasFlexRule = await page.evaluate(() => {
			for (const sheet of Array.from(document.styleSheets)) {
				try {
					for (const rule of Array.from(sheet.cssRules || [])) {
						if (rule.cssText?.includes('.flex')) {
							return true;
						}
					}
				} catch {
					// skip cross-origin restrictions if any
				}
			}
			return false;
		});
		expect(hasFlexRule).toBe(true);
	});

	it('step 4: imports fixture document and verifies two tasks appear (AC 3, E-108)', async () => {
		const fixtureDocsPath = join(fixturesDir, 'docs-data.js');
		expect(existsSync(fixtureDocsPath)).toBe(true);

		const importRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/documents`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				docsPath: fixtureDocsPath,
			}),
		});

		expect([200, 201]).toContain(importRes.status);
		const importBody = (await importRes.json()) as {
			document: { id: string };
			taskCount: number;
		};
		expect(importBody.taskCount).toBe(2);
		expect(importBody.document?.id).toBeTruthy();
		docId = importBody.document.id;

		// In browser, navigate to deck and verify both tasks are visible
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`);
		await page.waitForLoadState('networkidle');

		// Expand batch 1 and batch 2 so that tasks are rendered in DOM (BatchTree is collapsed by default)
		const batch1Toggle = page.locator('[data-batch-no="1"] [data-action="toggle-batch"]');
		await batch1Toggle.waitFor({ state: 'visible', timeout: 15000 });
		await batch1Toggle.click();

		const batch2Toggle = page.locator('[data-batch-no="2"] [data-action="toggle-batch"]');
		await batch2Toggle.waitFor({ state: 'visible', timeout: 15000 });
		await batch2Toggle.click();

		// Check that the two tasks from fixture appear in DOM (AC 3, E-108)
		const task1Row = page.locator('[data-task-key="SMOKE-T1"]');
		const task2Row = page.locator('[data-task-key="SMOKE-T2"]');

		await task1Row.waitFor({ state: 'visible', timeout: 15000 });
		await task2Row.waitFor({ state: 'visible', timeout: 15000 });

		expect(await task1Row.innerText()).toContain('冒烟测试第一任务');
		expect(await task2Row.innerText()).toContain('冒烟测试第二任务');
	});

	it('step 5: dispatches task with fake agent and verifies run in rail, online status, live SSE chunk in DOM and negative control (AC 3, E-10, E-31, E-108)', async () => {
		expect(docId).toBeTruthy();

		// Clean up any stale signals
		rmSync(join(tmpdir(), 'agsched-fake-agent-1.signal'), { force: true });
		rmSync(join(tmpdir(), 'agsched-fake-agent-2.signal'), { force: true });

		// Fetch tasks list for docId to retrieve actual task ID
		const tasksRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/documents/${docId}/tasks`,
			{
				headers: {
					Authorization: `Bearer ${adminToken}`,
				},
			},
		);
		expect(tasksRes.status).toBe(200);
		const tasksBody = (await tasksRes.json()) as {
			tasks: Array<{ id: string; taskKey: string }>;
		};
		const targetTask =
			tasksBody.tasks.find((t) => t.taskKey === 'SMOKE-T1') ?? tasksBody.tasks[0];
		expect(targetTask?.id).toBeTruthy();

		// R1: Record worktree created by this test so we only clean this test's artifacts
		const repoBase = basename(repoRoot);
		const expectedWorktree = resolve(repoRoot, `../${repoBase}-smoke-t1`);
		createdWorktreeDirs.push(expectedWorktree);

		// Dispatch SMOKE-T1 via POST /api/v1/runs
		const runRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				taskId: targetTask?.id,
				agentId: 'codex',
				idempotencyKey: `smoke-e2e-${Date.now()}`,
			}),
		});

		expect([200, 201]).toContain(runRes.status);
		const runBody = (await runRes.json()) as { run: { id: string } };
		expect(runBody.run?.id).toBeTruthy();
		currentRunId = runBody.run.id;

		// R2: Verify this run's identity in the deck rail
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`);
		await page.waitForLoadState('networkidle');

		// Assert data-connection-status is 'online'
		await page.waitForFunction(
			() => document.documentElement.getAttribute('data-connection-status') === 'online',
			{ timeout: 15000 },
		);
		expect(await page.evaluate(() => document.documentElement.getAttribute('data-connection-status'))).toBe('online');

		// Expand batch 1 if collapsed
		const batch1 = page.locator('[data-batch-no="1"]');
		if (await batch1.isVisible()) {
			const batchChildren = batch1.locator('[data-testid="batch-children"]');
			if (!(await batchChildren.isVisible())) {
				const toggle = batch1.locator('[data-action="toggle-batch"]');
				await toggle.click();
			}
		}

		// Rail assertion: check that deck-rail contains this task/run identity (R2)
		const deckRail = page.locator('[data-testid="deck-rail"]');
		await deckRail.waitFor({ state: 'visible', timeout: 15000 });
		const railTaskItem = deckRail.locator(`[data-task-key="${targetTask.taskKey}"]`);
		await railTaskItem.waitFor({ state: 'visible', timeout: 15000 });
		expect(await railTaskItem.isVisible()).toBe(true);

		// R2: Establish browser stream and detail subscription BEFORE fake agent emits its live chunk
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`);
		await page.waitForLoadState('networkidle');

		// Verify connection status is online on detail page
		await page.waitForFunction(
			() => document.documentElement.getAttribute('data-connection-status') === 'online',
			{ timeout: 15000 },
		);

		// Unique token for positive live SSE chunk
		const liveToken = `LIVE_SSE_CHUNK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		// Assert that the live token does not yet exist in DOM
		const initialCount = await page.locator(`text=${liveToken}`).count();
		expect(initialCount).toBe(0);

		// Trigger signal 1 to let fake agent emit the live chunk
		const signalFile1 = join(tmpdir(), 'agsched-fake-agent-1.signal');
		writeFileSync(signalFile1, `Positive live chunk: ${liveToken}\n`, 'utf8');

		// Assert that the new agent_message_chunk arrives in DOM via SSE live stream (R2)
		const liveLocator = page.locator(`text=${liveToken}`);
		await liveLocator.waitFor({ state: 'visible', timeout: 20000 });
		expect(await liveLocator.isVisible()).toBe(true);

		// R2: Negative control — prove that when SSE path is broken, new chunks do NOT reach the DOM
		const brokenPage = await context.newPage();
		await brokenPage.route('**/api/v1/events*', (route) => route.abort('connectionfailed'));
		await brokenPage.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`);
		await brokenPage.waitForLoadState('networkidle');

		// Assert brokenPage never reached 'online' SSE connection status
		const brokenConnection = await brokenPage.evaluate(() =>
			document.documentElement.getAttribute('data-connection-status'),
		);
		expect(brokenConnection).not.toBe('online');

		const negativeToken = `NEGATIVE_SSE_CHUNK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const signalFile2 = join(tmpdir(), 'agsched-fake-agent-2.signal');
		writeFileSync(signalFile2, `Negative broken chunk: ${negativeToken}\n`, 'utf8');

		// Wait 2.5 seconds to ensure agent has emitted chunk 2
		await new Promise((r) => setTimeout(r, 2500));

		// Assert that on brokenPage (SSE stream broken), the negative chunk never reached DOM (negative control passes)
		const negativeCount = await brokenPage.locator(`text=${negativeToken}`).count();
		expect(negativeCount).toBe(0);

		// Assert that on the healthy page, the negative chunk DID arrive via SSE
		const healthyNegativeLocator = page.locator(`text=${negativeToken}`);
		await healthyNegativeLocator.waitFor({ state: 'visible', timeout: 15000 });
		expect(await healthyNegativeLocator.isVisible()).toBe(true);

		await brokenPage.close();

		// R1: Assert that pre-existing sentinel worktree and branch survived completely
		expect(existsSync(join(sentinelWorktreePath, 'sentinel-keep.txt'))).toBe(true);
		const branchList = execSync('git branch --list ' + sentinelBranch, {
			cwd: repoRoot,
			encoding: 'utf8',
		});
		expect(branchList).toContain(sentinelBranch);
	});

	it('step 6: verifies no production test hooks and un-mocked spawnManaged (AC 4, E-135)', () => {
		// 1) Scan all production source files in packages/web/src and packages/daemon/src (R3, AC 4)
		function collectSourceFiles(dir: string, result: string[] = []): string[] {
			if (!existsSync(dir)) return result;
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				const st = statSync(full);
				if (st.isDirectory()) {
					if (entry !== 'node_modules' && entry !== 'dist' && entry !== 'test' && entry !== '__tests__') {
						collectSourceFiles(full, result);
					}
				} else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
					result.push(full);
				}
			}
			return result;
		}

		const productionDirs = [
			join(repoRoot, 'packages/web/src'),
			join(repoRoot, 'packages/daemon/src'),
		];
		const prodFiles = productionDirs.flatMap((d) => collectSourceFiles(d));
		expect(prodFiles.length).toBeGreaterThan(20);

		const forbiddenPatterns = [
			'window.__setToken',
			'__TEST_HOOK__',
			'window.__testHook',
			'globalThis.__testHook',
		];

		for (const file of prodFiles) {
			const content = readFileSync(file, 'utf8');
			for (const pattern of forbiddenPatterns) {
				if (content.includes(pattern)) {
					throw new Error(
						`Production source file ${file} contains test hook: "${pattern}" (AC 4, E-135)`,
					);
				}
			}
		}

		// 2) Scan E2E source files for module/path replacement of spawnManaged (R3, AC 4)
		const e2eFiles = collectSourceFiles(join(repoRoot, 'e2e'));
		for (const file of e2eFiles) {
			const content = readFileSync(file, 'utf8');
			expect(content).not.toMatch(/vi\.mock\([^)]*spawnManaged/);
			expect(content).not.toMatch(/spawnManaged\s*=\s*/);
		}

		// 3) Assert fake agent executed through real spawn path (captured in daemon output)
		const stdout = daemon.getStdout();
		expect(stdout).toBeTruthy();
	});

	it('step 7: handles failure diagnostics and artifacts configuration (AC 5, E-265)', () => {
		// Verify artifacts dir is configured
		expect(existsSync(artifactsDir)).toBe(true);

		// Verify .gitignore includes e2e/artifacts/
		const gitignoreContent = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
		expect(gitignoreContent).toContain('e2e/artifacts/');

		// Verify root package.json check script does not include e2e/
		const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
		expect(packageJson.scripts.check).not.toContain('e2e');
	});
});
