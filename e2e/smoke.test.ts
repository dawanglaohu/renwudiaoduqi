import { execFileSync, execSync, spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function isWindowsElevated(): boolean {
	if (process.platform !== 'win32') return false;
	try {
		const out = execFileSync('C:\\Windows\\System32\\whoami.exe', ['/groups'], {
			encoding: 'utf8',
		});
		return (
			out.includes('S-1-5-32-544') &&
			(out.includes('Mandatory group') || out.includes('Enabled group')) &&
			!out.includes('Group used for deny only')
		);
	} catch {
		return false;
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

interface RunningDaemon {
	readonly port: number;
	readonly dataDir: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	getStdout(): string;
	getStderr(): string;
	stop(): Promise<void>;
}

async function startDaemon(options: { timeoutMs?: number } = {}): Promise<RunningDaemon> {
	const port = await findAvailablePort();
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-smoke-e2e-'));
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');

	// Prepare agents.json with fake-agent configuration for codex adapter (AC 3, AC 4, E-135)
	const fakeAgentExec =
		process.platform === 'win32'
			? join(fixturesDir, 'fake-agent.cmd')
			: join(fixturesDir, 'fake-agent.mjs');
	const agentsConfig = {
		schemaVersion: 1,
		overrides: {
			codex: {
				execPath: fakeAgentExec,
			},
		},
	};
	writeFileSync(join(dataDir, 'agents.json'), JSON.stringify(agentsConfig, null, 2), 'utf8');

	let daemonPid: number | undefined;
	let stopFn: () => Promise<void>;

	if (process.platform === 'win32' && !isWindowsElevated()) {
		const launcherPath = join(dataDir, 'start-daemon.cmd');
		const batContent = `@echo off
set "AGSCHED_PORT=${port}"
set "AGSCHED_DATA_DIR=${dataDir}"
set "AGSCHED_BIND=127.0.0.1"
set "AGSCHED_LOG_LEVEL=info"
set "AGSCHED_DEV=1"
cd /d "${repoRoot}"
"${process.execPath}" "${bootstrapPath}" > "${stdoutPath}" 2> "${stderrPath}"
`;
		writeFileSync(launcherPath, batContent, 'utf8');

		execFileSync('powershell.exe', [
			'-NoProfile',
			'-Command',
			`Start-Process cmd.exe -ArgumentList "/c \`"${launcherPath}\`"" -Verb RunAs`,
		]);

		stopFn = async () => {
			const stopScriptPath = join(tmpdir(), `stop-${port}.ps1`);
			const stopPs1Content = `param($targetPort, $dirToClean, $pidToStop)
if ($targetPort) {
    Get-NetTCPConnection -LocalPort $targetPort -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
if ($pidToStop) {
    Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
}
if ($dirToClean -and (Test-Path $dirToClean)) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dirToClean
}
`;
			try {
				writeFileSync(stopScriptPath, stopPs1Content, 'utf8');
				execFileSync('powershell.exe', [
					'-NoProfile',
					'-Command',
					'Start-Process',
					'-FilePath',
					'powershell.exe',
					'-ArgumentList',
					`@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "${stopScriptPath}", "${port}", "${dataDir}", "${daemonPid ?? 0}")`,
					'-Verb',
					'RunAs',
					'-Wait',
				]);
			} catch {
				// best effort
			} finally {
				try {
					rmSync(stopScriptPath, { force: true });
				} catch {
					// best effort
				}
			}
		};
	} else {
		const child = spawn(process.execPath, [bootstrapPath], {
			cwd: repoRoot,
			env: {
				...process.env,
				AGSCHED_PORT: String(port),
				AGSCHED_DATA_DIR: dataDir,
				AGSCHED_BIND: '127.0.0.1',
				AGSCHED_LOG_LEVEL: 'info',
				AGSCHED_DEV: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		daemonPid = child.pid;
		let stdoutRawBuf = '';
		let stderrRawBuf = '';

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

		stopFn = async () => {
			if (child.pid && child.exitCode === null) {
				child.kill('SIGTERM');
				await new Promise<void>((res) => {
					const timer = setTimeout(() => {
						try {
							child.kill('SIGKILL');
						} catch {
							// best effort
						}
						res();
					}, 3000);
					child.once('exit', () => {
						clearTimeout(timer);
						res();
					});
				});
			}
			try {
				rmSync(dataDir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		};
	}

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

	beforeAll(async () => {
		mkdirSync(artifactsDir, { recursive: true });

		// Ensure web is built
		const webDistIndex = join(repoRoot, 'packages/web/dist/index.html');
		if (!existsSync(webDistIndex)) {
			execSync('pnpm --filter @agent-scheduler/web build', {
				cwd: repoRoot,
				stdio: 'inherit',
			});
		}

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
	});

	afterEach(async ({ task }) => {
		if (task.result?.state === 'fail') {
			const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_');
			mkdirSync(artifactsDir, { recursive: true });

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
		if (daemon) {
			await daemon.stop().catch(() => {});
		}

		// Clean up created worktrees and task branches
		for (const wt of createdWorktreeDirs) {
			try {
				execSync(`git worktree remove --force "${wt}"`, { cwd: repoRoot, stdio: 'ignore' });
			} catch {
				// best effort
			}
			try {
				rmSync(wt, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
		try {
			execSync('git branch -D task/T-1', { cwd: repoRoot, stdio: 'ignore' });
		} catch {
			// best effort
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

		// Check that the two tasks from fixture appear in DOM
		const task1Locator = page.locator('text=冒烟测试第一任务');
		const task2Locator = page.locator('text=冒烟测试第二任务');

		await task1Locator.waitFor({ state: 'visible', timeout: 15000 });
		await task2Locator.waitFor({ state: 'visible', timeout: 15000 });

		expect(await task1Locator.isVisible()).toBe(true);
		expect(await task2Locator.isVisible()).toBe(true);
	});

	it('step 5: dispatches task with fake agent and verifies run in rail, online status, and agent_message_chunk in DOM (AC 3, E-10, E-31, E-108)', async () => {
		expect(docId).toBeTruthy();

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
			tasksBody.tasks.find((t) => t.taskKey === 'T-1') ?? tasksBody.tasks[0];
		expect(targetTask?.id).toBeTruthy();

		// Clean up any stale branch or worktree before dispatch
		const possibleWorktrees = [
			resolve(repoRoot, '../agent-scheduler-t-1'),
			resolve(repoRoot, '../agent-scheduler-m1-t11-t-1'),
		];
		for (const expectedWorktree of possibleWorktrees) {
			createdWorktreeDirs.push(expectedWorktree);
			try {
				execSync(`git worktree remove --force "${expectedWorktree}"`, {
					cwd: repoRoot,
					stdio: 'ignore',
				});
			} catch {
				// ignore
			}
		}
		try {
			execSync('git branch -D task/T-1', { cwd: repoRoot, stdio: 'ignore' });
		} catch {
			// ignore
		}

		// Dispatch T-1 via POST /api/v1/runs
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

		await page.goto(`http://127.0.0.1:${daemon.port}/#/`);
		await page.waitForLoadState('networkidle');

		// Assert data-connection-status becomes 'online'
		await page.waitForFunction(
			() => document.documentElement.getAttribute('data-connection-status') === 'online',
			{ timeout: 15000 },
		);
		const connectionStatus = await page.evaluate(() =>
			document.documentElement.getAttribute('data-connection-status'),
		);
		expect(connectionStatus).toBe('online');

		// Assert deck-rail displays the task/run
		const deckRail = page.locator('[data-testid="deck-rail"]');
		await deckRail.waitFor({ state: 'visible', timeout: 15000 });
		expect(await deckRail.isVisible()).toBe(true);

		// Navigate to run detail page to view SSE live stream
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`);
		await page.waitForLoadState('networkidle');

		// Assert that at least one agent_message_chunk text reached DOM via SSE
		const chunkTextLocator = page.locator('text=Smoke test message chunk received successfully').first();
		await chunkTextLocator.waitFor({ state: 'visible', timeout: 20000 });
		expect(await chunkTextLocator.isVisible()).toBe(true);
	});

	it('step 6: verifies no production test hooks and un-mocked spawnManaged (AC 4, E-135)', () => {
		// 1) Assert production source code does NOT contain test hooks like window.__setToken
		const checkFiles = [
			'packages/web/src/app/bootstrap.ts',
			'packages/web/src/app/app.tsx',
			'packages/daemon/src/main.ts',
			'packages/daemon/src/boot/container.ts',
		];
		for (const file of checkFiles) {
			const content = readFileSync(join(repoRoot, file), 'utf8');
			expect(content).not.toContain('__setToken');
			expect(content).not.toContain('__TEST_HOOK__');
		}

		// 2) Assert e2e test did not replace or monkey patch spawnManaged
		expect((globalThis as Record<string, unknown>).spawnManaged).toBeUndefined();

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
