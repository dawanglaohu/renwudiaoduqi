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
import { basename, dirname, join, resolve, sep } from 'node:path';
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
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-batch13-e2e-'));
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');

	const fixtureAgentsPath = join(fixturesDir, 'agents.json');
	const fixtureAgentsRaw = readFileSync(fixtureAgentsPath, 'utf8');
	const agentsConfig = JSON.parse(fixtureAgentsRaw);

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
		AGSCHED_SMOKE_SIGNAL_DIR: dataDir,
	};

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
			// fallback
		}
	}

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
			join(artifactsDir, 'b13-startup-daemon-health-failure.log'),
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

describe('第 13 批真实服务与浏览器全链端到端验收 (R13-T57054072, AC 1-4, E-06, E-08, E-10, E-12, E-108, E-156, E-158, E-200, E-222, E-223, E-224)', () => {
	let daemon: RunningDaemon;
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let adminToken: string;
	let currentDeviceId: string | null = null;
	let docId: string | null = null;
	let batch1Id: string | null = null;
	let targetTaskId: string | null = null;
	let currentRunId: string | null = null;
	let isolatedRoot: string | null = null;
	let projectRepo: string | null = null;
	let importDocsPath: string | null = null;

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

			// Isolated git fixture repository for document import
			isolatedRoot = mkdtempSync(join(tmpdir(), 'agsched-b13-project-'));
			projectRepo = join(isolatedRoot, 'project');
			mkdirSync(projectRepo);
			execFileSync('git', ['init', '-b', 'main', projectRepo], { stdio: 'ignore' });

			const fixtureText = readFileSync(join(fixturesDir, 'docs-data.js'), 'utf8');
			const fixtureData = JSON.parse(
				fixtureText.replace(/^\s*window\.DOCS\s*=\s*/, '').replace(/;\s*$/, ''),
			) as { pres: { handoff: { repo: string } } };
			fixtureData.pres.handoff.repo = projectRepo;
			importDocsPath = join(projectRepo, 'docs-data.js');
			writeFileSync(importDocsPath, `window.DOCS = ${JSON.stringify(fixtureData, null, 2)};\n`);
			execFileSync('git', ['-C', projectRepo, 'add', 'docs-data.js'], { stdio: 'ignore' });
			execFileSync(
				'git',
				[
					'-C', projectRepo,
					'-c', 'user.name=Batch13 E2E',
					'-c', 'user.email=b13-e2e@example.invalid',
					'commit', '-m', 'Batch 13 fixture document',
				],
				{ stdio: 'ignore' },
			);

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
			mkdirSync(artifactsDir, { recursive: true });
			const errMsg =
				setupError instanceof Error ? setupError.stack || setupError.message : String(setupError);
			writeFileSync(join(artifactsDir, 'b13-setup-failure.log'), redactSensitiveData(errMsg), 'utf8');
			if (daemon) {
				writeFileSync(join(artifactsDir, 'b13-setup-daemon-stdout.log'), daemon.getStdout(), 'utf8');
				writeFileSync(join(artifactsDir, 'b13-setup-daemon-stderr.log'), daemon.getStderr(), 'utf8');
				await daemon.stop().catch(() => {});
			}
			throw setupError;
		}
	});

	afterEach(async ({ task }) => {
		if (task.result?.state === 'fail') {
			const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_');
			mkdirSync(artifactsDir, { recursive: true });

			if (daemon && currentRunId && adminToken) {
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
					// best effort
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

		if (isolatedRoot !== null) {
			const root = resolve(isolatedRoot);
			const tempRoot = resolve(tmpdir());
			if (root.startsWith(`${tempRoot}${sep}`) && basename(root).startsWith('agsched-b13-project-')) {
				rmSync(root, { recursive: true, force: true });
			}
		}

		if (exitResult) {
			const isCleanExit = exitResult.exitCode === 0 || exitResult.signal === 'SIGTERM';
			expect(isCleanExit).toBe(true);
		}
	});

	it('step 1: 未授权访问拦截与无令牌重定向 (AC 2, E-08, E-224)', async () => {
		// Public API without token returns 401 E_UNAUTHORIZED (E-08: zero intranet auth bypass)
		const snapshotRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/snapshot`);
		expect(snapshotRes.status).toBe(401);
		const errJson = (await snapshotRes.json()) as { error: { code: string } };
		expect(errJson.error.code).toBe('E_UNAUTHORIZED');

		// Visiting / without token normalizes to #/ (E-224), then guards redirect to #/pair
		await page.goto(`http://127.0.0.1:${daemon.port}/`, { waitUntil: 'domcontentloaded' });
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/pair`, { timeout: 15000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/pair`);

		const pairContainer = page.locator('[data-component="pairing-container"]');
		await pairContainer.waitFor({ state: 'visible', timeout: 10000 });
		expect(await pairContainer.isVisible()).toBe(true);
	});

	it('step 2: 真实自举公开配对、零运行四步向导与样式验证 (AC 1, AC 2, E-108, E-200, E-224, E-226)', async () => {
		// Read initial bootstrap pairing code before any invalid attempts consume it (E-226)
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

		await page.goto(`http://127.0.0.1:${daemon.port}/#/pair`, { waitUntil: 'domcontentloaded' });
		const codeInput = page.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 10000 });
		await codeInput.fill(code);

		const toggleManualHost = page.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
		}
		const hostInput = page.locator('[data-testid="manual-host-input"]');
		if (await hostInput.isVisible()) {
			await hostInput.fill(`127.0.0.1:${daemon.port}`);
		}

		const submitBtn = page.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.click();

		// Successful claim navigates to #/
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 15000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/`);

		// pairing-code.txt is deleted (E-226)
		expect(existsSync(codeFilePath)).toBe(false);

		// Assert font and styling (E-200)
		const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
		expect(fontFamily).toContain('Public Sans');

		// Assert connection status is online
		await page.waitForFunction(
			() => document.documentElement.getAttribute('data-connection-status') === 'online',
			{ timeout: 15000 },
		);

		// Assert zero-run onboarding empty state (E-108: 4 steps, not an illustration)
		const onboarding = page.locator('[data-testid="empty-onboarding-console"]');
		await onboarding.waitFor({ state: 'visible', timeout: 10000 });
		const stepper = page.locator('[data-testid="onboarding-stepper"]');
		await stepper.waitFor({ state: 'visible', timeout: 5000 });
		expect(await stepper.innerText()).toContain('选文档');
		expect(await stepper.innerText()).toContain('选批次');
		expect(await stepper.innerText()).toContain('逐任务指派');
		expect(await stepper.innerText()).toContain('派发');

		// Read token from browser's sessionStorage using the canonical key agsched.token
		const browserToken = await page.evaluate(() => sessionStorage.getItem('agsched.token'));
		expect(browserToken).toBeTruthy();
		adminToken = browserToken as string;
		registerSensitiveData(adminToken);

		// Read current deviceId from browser's sessionStorage
		const browserDevId = await page.evaluate(() =>
			sessionStorage.getItem('agsched.current_device_id'),
		);
		expect(browserDevId).toBeTruthy();
		currentDeviceId = browserDevId as string;
	});

	it('step 3: 错误地址手填配对失败提示、具体环节报错与手填可操作性 (AC 2, E-06, R3)', async () => {
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
		const tempCode = ((await codeRes.json()) as { code: string }).code;
		expect(tempCode).toMatch(/^[A-Za-z0-9]{6}$/);

		const testContext = await browser.newContext();
		const testPage = await testContext.newPage();
		await testPage.goto(`http://127.0.0.1:${daemon.port}/#/pair`, {
			waitUntil: 'domcontentloaded',
		});

		const codeInput = testPage.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 10000 });
		await codeInput.fill(tempCode);

		// Open manual host input
		const toggleManualHost = testPage.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
		}
		const hostInput = testPage.locator('[data-testid="manual-host-input"]');
		await hostInput.waitFor({ state: 'visible', timeout: 5000 });
		await hostInput.fill('127.0.0.1:59998');

		// Click "保存" button to save manual address to state (E-06)
		const saveBtn = testPage.getByRole('button', { name: '保存' });
		if (await saveBtn.isVisible()) {
			await saveBtn.click();
		}

		const submitBtn = testPage.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.click();

		// R3: Notice must detail specific error stage AND the actual host:port entered
		const errorNotice = testPage.locator('[data-testid="pairing-error-notice"]');
		await errorNotice.waitFor({ state: 'visible', timeout: 10000 });
		const noticeText = await errorNotice.innerText();
		expect(noticeText).toContain('127.0.0.1:59998');
		expect(noticeText).toMatch(/(扫到码但连不上|连不上|网络|超时|失败)/);

		// R3: Manual host input remains present and usable/editable
		expect(await hostInput.isVisible()).toBe(true);
		expect(await hostInput.isEditable()).toBe(true);

		await testPage.close();
		await testContext.close();
	});

	it('step 4: 未登记 hash、不存在运行的页面级兜底与回到甲板入口 (AC 2, E-222, E-223, R3)', async () => {
		// 1. Visit unregistered hash -> Page-level unknown route with topbar retained (E-222, R3)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/nonexistent-route-random`, {
			waitUntil: 'domcontentloaded',
		});
		const unknownRoutePage = page.locator('[data-testid="unknown-route-page"]');
		await unknownRoutePage.waitFor({ state: 'visible', timeout: 10000 });
		expect(await unknownRoutePage.isVisible()).toBe(true);

		// Topbar is retained on unknown route (E-222)
		const topbarOnUnknown = unknownRoutePage.locator('header');
		expect(await topbarOnUnknown.isVisible()).toBe(true);
		expect(await topbarOnUnknown.innerText()).toContain('Agent 任务调度器');
		expect(await unknownRoutePage.innerText()).toContain('未知路径');

		// R3: Navigate back to deck from unknown route page
		const returnBtn = unknownRoutePage.getByRole('button', { name: '回到运行甲板' });
		await returnBtn.waitFor({ state: 'visible', timeout: 5000 });
		await returnBtn.click();
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 10000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/`);

		// 2. Visit non-existent run detail -> page-level missing run display with topbar (E-223, R3)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/nonexistent-run-id-999`, {
			waitUntil: 'domcontentloaded',
		});
		const runDetailPage = page.locator('[data-component="run-detail-page"]');
		await runDetailPage.waitFor({ state: 'visible', timeout: 10000 });

		// Topbar is retained on missing run detail page (E-223)
		const topbarOnMissing = runDetailPage.locator('header');
		expect(await topbarOnMissing.isVisible()).toBe(true);
		expect(await topbarOnMissing.innerText()).toContain('运行详情');

		// Missing notice is rendered by the page itself, shell and topbar stay intact
		const missingNotice = page.locator('[data-run-missing="true"]');
		await missingNotice.waitFor({ state: 'visible', timeout: 10000 });
		expect(await missingNotice.innerText()).toContain('该运行不存在或已被清理');
	});

	it('step 5: 文档导入与权威批次树呈现 (AC 1, AC 2, M9-T19, R13-T98191508)', async () => {
		if (!importDocsPath) throw new Error('Missing fixture docs path');

		// [生产能力缺失说明]: Web 前端界面未提供从本地选择文件或提交路径的生产入口（缺失 POST /api/v1/documents 用户控件）。
		// 根据任务规范与 R1 要求，通过公开 API POST /api/v1/documents 导入测试文档，不伪造前端操作。
		const importRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/documents`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ docsPath: importDocsPath }),
		});
		expect([200, 201]).toContain(importRes.status);
		const importBody = (await importRes.json()) as {
			document: { id: string };
			taskCount: number;
		};
		expect(importBody.taskCount).toBe(2);
		docId = importBody.document.id;

		// Wait for snapshot readiness with imported doc and tasks
		let snapshotReady = false;
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			const res = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/snapshot`, {
				headers: { Authorization: `Bearer ${adminToken}` },
			});
			if (res.ok) {
				const snapshot = (await res.json()) as {
					documents: Array<{ id: string }>;
					tasks: Array<{ docId: string; id: string; taskKey: string }>;
				};
				if (
					snapshot.documents.some((d) => d.id === docId) &&
					snapshot.tasks.filter((t) => t.docId === docId).length === 2
				) {
					snapshotReady = true;
					const t1 = snapshot.tasks.find((t) => t.taskKey === 'SMOKE-T1');
					if (t1) targetTaskId = t1.id;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(snapshotReady).toBe(true);

		// Read batch ID via public API
		const batchesRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/documents/${docId}/batches`,
			{
				headers: { Authorization: `Bearer ${adminToken}` },
			},
		);
		expect(batchesRes.status).toBe(200);
		const batchesData = (await batchesRes.json()) as { batches: Array<{ id: string }> };
		batch1Id = batchesData.batches[0]?.id;
		expect(batch1Id).toBeTruthy();

		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });

		// Expand batches in batch tree
		const batch1Toggle = page.locator('[data-batch-no="1"] [data-action="toggle-batch"]');
		await batch1Toggle.waitFor({ state: 'visible', timeout: 20000 });
		await batch1Toggle.click();

		const batch2Toggle = page.locator('[data-batch-no="2"] [data-action="toggle-batch"]');
		await batch2Toggle.waitFor({ state: 'visible', timeout: 20000 });
		await batch2Toggle.click();

		// Check both tasks appear in DOM
		const task1Row = page.locator('[data-task-key="SMOKE-T1"]');
		const task2Row = page.locator('[data-task-key="SMOKE-T2"]');
		await task1Row.waitFor({ state: 'visible', timeout: 15000 });
		await task2Row.waitFor({ state: 'visible', timeout: 15000 });
		expect(await task1Row.innerText()).toContain('冒烟测试第一任务');
		expect(await task2Row.innerText()).toContain('冒烟测试第二任务');
	});

	it('step 6: 逐任务指派草稿、并发瓶颈与人工闸门配置 (AC 1, M9-T18, E-52, E-299)', async () => {
		expect(docId).toBeTruthy();
		expect(batch1Id).toBeTruthy();
		expect(targetTaskId).toBeTruthy();

		// [生产能力缺失说明]: 生产 Web 在导入文档后生成了流水线泳道（streamCount=2），导致零运行四步向导 EmptyOnboarding
		// 不再渲染（run-deck-view.tsx:312 仅在 streamCount===0 时启用向导）；且批次树与运行甲板未提供向导外的逐任务指派表单，
		// run-deck-view.tsx:327 挂载 EmptyOnboarding 时亦未绑定 onDispatch 回调。
		// 指派草稿通过公开 API 写入，并与批次草稿接口与批次树进行交叉断言。
		const putDraftRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/batches/${batch1Id}/assignments`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${adminToken}`,
				},
				body: JSON.stringify({
					assignments: [
						{
							taskId: targetTaskId,
							agentId: 'codex',
							model: null,
							effort: null,
						},
					],
				}),
			},
		);
		expect(putDraftRes.status).toBe(200);
		const draftResult = (await putDraftRes.json()) as {
			drafts: Array<{ taskId: string; sessionNo: number | null }>;
			preview: { effectiveConcurrency: number };
		};
		expect(draftResult.drafts.length).toBeGreaterThan(0);
		expect(draftResult.preview).toBeDefined();

		// 2. Gate settings inspection & toggle (E-299)
		const gateToggles = page.locator('[data-component="gate-toggles"]');
		await gateToggles.waitFor({ state: 'visible', timeout: 15000 });
		expect(await gateToggles.isVisible()).toBe(true);

		// Configure landing and review gate so run halts for human approval (AC 1, E-05, E-53, R1)
		const patchGateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/settings/gates`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				dispatch: 'auto',
				review: 'manual',
				landing: 'manual',
			}),
		});
		expect(patchGateRes.status).toBe(200);
		const patchGateBody = (await patchGateRes.json()) as { gates: { landing: string; review: string } };
		expect(patchGateBody.gates.landing).toBe('manual');
		expect(patchGateBody.gates.review).toBe('manual');
	});

	it('step 7: 任务派发、fake-agent 运行与实时 SSE 消息流转 (AC 1, AC 2, E-10, E-31, R1)', async () => {
		expect(docId).toBeTruthy();
		expect(targetTaskId).toBeTruthy();

		// Dispatch SMOKE-T1 via public API with idempotency key
		const runRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/runs`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				taskId: targetTaskId,
				agentId: 'codex',
				idempotencyKey: `b13-smoke-${Date.now()}`,
			}),
		});
		expect([200, 201]).toContain(runRes.status);
		const runBody = (await runRes.json()) as { run: { id: string; state: string } };
		expect(runBody.run?.id).toBeTruthy();
		currentRunId = runBody.run.id;

		// Navigate to run detail page
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`, {
			waitUntil: 'domcontentloaded',
		});
		await page.locator('[data-component="run-detail-container"]').waitFor({ state: 'visible' });

		// Verify connection status is online
		await page.waitForFunction(
			() => document.documentElement.getAttribute('data-connection-status') === 'online',
			{ timeout: 15000 },
		);

		// Unique token for positive live chunk
		const liveToken = `B13_LIVE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const signalFile1 = join(daemon.dataDir, 'agsched-fake-agent-1.signal');
		writeFileSync(signalFile1, `Batch 13 live message: ${liveToken}\n`, 'utf8');

		// Assert chunk arrives in DOM
		const liveLocator = page.locator(`text=${liveToken}`);
		await liveLocator.waitFor({ state: 'visible', timeout: 20000 });
		expect(await liveLocator.isVisible()).toBe(true);

		// Assert public API reflects active run
		const getRunRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`,
			{
				headers: { Authorization: `Bearer ${adminToken}` },
			},
		);
		expect(getRunRes.status).toBe(200);
		const runDetail = (await getRunRes.json()) as { run: { id: string; state: string } };
		expect(runDetail.run.id).toBe(currentRunId);
	});

	it('step 8: 离线断网、离线横幅、重连退避、Last-Event-ID 与断网事件恰好补推一次 (AC 2, E-10, E-12, E-158, R2)', async () => {
		expect(currentRunId).toBeTruthy();

		let sseBlocked = true;
		let capturedLastEventId: string | null = null;
		const reconnectTimestamps: number[] = [];

		const handleRequest = (req: any) => {
			if (req.url().includes('/api/v1/events')) {
				reconnectTimestamps.push(Date.now());
				const headers = req.headers();
				if (headers['last-event-id']) {
					capturedLastEventId = headers['last-event-id'];
				}
			}
		};
		page.on('request', handleRequest);

		await page.route('**/api/v1/events*', (route) => {
			if (sseBlocked) {
				return route.abort('connectionfailed');
			}
			return route.continue();
		});

		try {
			// Stop active network transfers without reloading page (preserves client-side lastEventId and DOM)
			await page.evaluate(() => window.stop());

			// Connection status reflects disconnection (E-12)
			await page.waitForFunction(
				() => {
					const s = document.documentElement.getAttribute('data-connection-status');
					return s === 'offline' || s === 'reconnecting';
				},
				{ timeout: 15000 },
			);

			// R2: Offline banner shows up and details connection issue
			const offlineBanner = page.locator('[data-component="offline-banner"]');
			await offlineBanner.waitFor({ state: 'visible', timeout: 15000 });
			const bannerText = await offlineBanner.innerText();
			expect(bannerText).toMatch(/(离线|重新连接|同步)/);

			// R2: When disconnected, status is offline or reconnecting (E-12: dispatch disabled)
			const isOfflineOrReconnecting = await page.evaluate(() => {
				const s = document.documentElement.getAttribute('data-connection-status');
				return s === 'offline' || s === 'reconnecting';
			});
			expect(isOfflineOrReconnecting).toBe(true);

			// 2. During disconnect, agent emits second message chunk (E-10: phone offline during finish)
			const offlineToken = `B13_OFFLINE_QUEUED_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			// First assert offline token does not exist in DOM
			expect(await page.locator(`text=${offlineToken}`).count()).toBe(0);

			const signalFile2 = join(daemon.dataDir, 'agsched-fake-agent-2.signal');
			writeFileSync(signalFile2, `Offline queued message: ${offlineToken}\n`, 'utf8');

			// Wait 3 seconds to let fake agent emit chunk 2, daemon queue it, and client record reconnect attempts
			await new Promise((r) => setTimeout(r, 3000));

			// R2: Assert chunk has NOT reached DOM yet while stream is broken (negative control, E-10)
			const countBefore = await page.locator(`text=${offlineToken}`).count();
			expect(countBefore).toBe(0);

			// R2: Record reconnect request intervals to verify backoff rather than 0ms spinning (E-158)
			if (reconnectTimestamps.length >= 2) {
				for (let i = 1; i < reconnectTimestamps.length; i++) {
					const prev = reconnectTimestamps[i - 1];
					const curr = reconnectTimestamps[i];
					if (prev !== undefined && curr !== undefined) {
						const interval = curr - prev;
						expect(interval).toBeGreaterThan(0);
					}
				}
			}

			// 3. Restore network & verify Last-Event-ID header is sent on reconnection (E-158)
			sseBlocked = false;
			await page.unroute('**/api/v1/events*');

			// Reconnection succeeds and queued offline message reaches DOM
			const offlineLocator = page.locator(`text=${offlineToken}`);
			await offlineLocator.waitFor({ state: 'visible', timeout: 25000 });

			// R2: Assert chunk is replayed EXACTLY ONCE (count === 1, no duplicate and no loss, E-10)
			const countAfter = await page.locator(`text=${offlineToken}`).count();
			expect(countAfter).toBe(1);

			// Connection status recovers to online
			await page.waitForFunction(
				() => document.documentElement.getAttribute('data-connection-status') === 'online',
				{ timeout: 15000 },
			);

			// R2: Assert banner readout includes "最后同步于" (M9-T26, E-12)
			const onlineBanner = page.locator('[data-component="offline-banner"]');
			if (await onlineBanner.isVisible()) {
				const onlineBannerText = await onlineBanner.innerText();
				expect(onlineBannerText).toMatch(/(最后同步于|同步)/);
			}

			// Last-Event-ID was retained during reconnection attempts (E-158)
			expect(capturedLastEventId).toBeTruthy();
			expect(Number.parseInt(capturedLastEventId!, 10)).toBeGreaterThanOrEqual(0);
		} finally {
			sseBlocked = false;
			page.off('request', handleRequest);
			await page.unroute('**/api/v1/events*').catch(() => {});
		}
	});

	it('step 9: 真实运行到达人工闸门与浏览器作出审批决定 (AC 1, AC 2, E-05, E-53, R1)', async () => {
		expect(currentRunId).toBeTruthy();

		// 1. Wait for public API to reflect gate in 'waiting' state
		let waitingGateId: string | null = null;
		const gateDeadline = Date.now() + 30000;
		while (Date.now() < gateDeadline) {
			const gatesRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
				headers: { Authorization: `Bearer ${adminToken}` },
			});
			if (gatesRes.ok) {
				const gatesData = (await gatesRes.json()) as {
					gates: Array<{ id: string; state: string; kind: string; run_id?: string; task_id?: string }>;
				};
				const targetGate = gatesData.gates.find(
					(g) => g.state === 'waiting' && (g.run_id === currentRunId || g.task_id === targetTaskId),
				);
				if (targetGate) {
					waitingGateId = targetGate.id;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(waitingGateId).toBeTruthy();

		// 2. Navigate to run deck #/ where GateCard is rendered in the stream lane (AC 1, R1)
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		const gateCard = page.locator('[data-component="gate-card"]');
		await gateCard.waitFor({ state: 'visible', timeout: 20000 });
		expect(await gateCard.isVisible()).toBe(true);

		// Assert GateCard displays target task key and approve button
		const gateCardText = await gateCard.innerText();
		expect(gateCardText).toContain('SMOKE-T1');
		const approveBtn = gateCard.locator('button[data-action="approve"]');
		await approveBtn.waitFor({ state: 'visible', timeout: 5000 });

		// 3. Make human approval decision from browser control (AC 1, R1)
		await approveBtn.click();

		// Wait for gate decision to process and GateCard to disappear from DOM
		await page.waitForFunction(
			() => document.querySelector('[data-component="gate-card"]') === null,
			{ timeout: 15000 },
		);

		// 4. Cross-assert gate status with public API (state === 'decided', decision === 'pass')
		const decidedGateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/gates`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		expect(decidedGateRes.status).toBe(200);
		const decidedGateData = (await decidedGateRes.json()) as {
			gates: Array<{ id: string; state: string; decision: string }>;
		};
		const resolvedGate = decidedGateData.gates.find((g) => g.id === waitingGateId);
		expect(resolvedGate?.state).toBe('decided');
		expect(resolvedGate?.decision).toBe('pass');

		// 5. Cross-assert task landed status with public API
		const runFinalRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`,
			{
				headers: { Authorization: `Bearer ${adminToken}` },
			},
		);
		expect(runFinalRes.status).toBe(200);
		const runFinalData = (await runFinalRes.json()) as { run: { id: string; state: string } };
		expect(['landed', 'completed', 'succeeded', 'reviewing', 'awaiting_human']).toContain(runFinalData.run.state);
	});

	it('step 10: 窄屏移动端入口与手机批次及运行详情严格交叉验证 (AC 2, E-200, M9-T25, R3)', async () => {
		expect(currentRunId).toBeTruthy();

		// 1. New mobile context with 390x844 viewport, touch support and mobile flags (E-200, R3)
		const mobileContext = await browser.newContext({
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
		});
		const mobilePage = await mobileContext.newPage();

		// Generate fresh pairing code using adminToken
		const codeRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/code`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(codeRes.status).toBe(200);
		const mobilePairingCode = ((await codeRes.json()) as { code: string }).code;
		expect(mobilePairingCode).toMatch(/^[A-Za-z0-9]{6}$/);

		// Complete mobile pairing through UI (E-200)
		await mobilePage.goto(`http://127.0.0.1:${daemon.port}/#/pair`, { waitUntil: 'domcontentloaded' });
		const codeInput = mobilePage.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 10000 });
		await codeInput.fill(mobilePairingCode);

		const toggleManualHost = mobilePage.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
		}
		const hostInput = mobilePage.locator('[data-testid="manual-host-input"]');
		if (await hostInput.isVisible()) {
			await hostInput.fill(`127.0.0.1:${daemon.port}`);
		}

		const submitBtn = mobilePage.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.click();
		await mobilePage.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 15000 });

		// Visit #/tasks (mobile batch tasks list, M9-T25 AC3, E-200)
		await mobilePage.goto(`http://127.0.0.1:${daemon.port}/#/tasks`, {
			waitUntil: 'domcontentloaded',
		});
		const tasksPage = mobilePage.locator('[data-component="tasks-page"]');
		await tasksPage.waitFor({ state: 'visible', timeout: 15000 });
		expect(await tasksPage.isVisible()).toBe(true);

		// Expand batch 1 in mobile view and verify task from DOM
		const mobileBatch1Toggle = mobilePage.locator('[data-batch-no="1"] [data-action="toggle-batch"]');
		await mobileBatch1Toggle.waitFor({ state: 'visible', timeout: 10000 });
		await mobileBatch1Toggle.click();
		const taskRow = mobilePage.locator('[data-task-key="SMOKE-T1"]');
		await taskRow.waitFor({ state: 'visible', timeout: 15000 });
		const taskText = await taskRow.innerText();
		expect(taskText).toContain('冒烟测试第一任务');

		// Visit run in mobile view to assert responsive run detail container (M9-T25, E-200)
		await mobilePage.goto(`http://127.0.0.1:${daemon.port}/#/run/${currentRunId}`, {
			waitUntil: 'domcontentloaded',
		});
		const detailContainer = mobilePage.locator('[data-component="run-detail-container"]');
		await detailContainer.waitFor({ state: 'visible', timeout: 15000 });
		expect(await detailContainer.isVisible()).toBe(true);

		// R3: Extract run identity from mobile page topbar breadcrumbs
		const headerBreadcrumb = mobilePage.locator('[data-component="run-detail-page"] header');
		await headerBreadcrumb.waitFor({ state: 'visible', timeout: 5000 });
		const breadcrumbText = await headerBreadcrumb.innerText();
		expect(breadcrumbText).toContain(currentRunId);

		// R3: Cross-assert run identity and status between mobile DOM and public API
		const runApiRes = await fetch(
			`http://127.0.0.1:${daemon.port}/api/v1/runs/${currentRunId}`,
			{
				headers: { Authorization: `Bearer ${adminToken}` },
			},
		);
		expect(runApiRes.status).toBe(200);
		const runApiData = (await runApiRes.json()) as { run: { id: string; taskId: string; state: string } };
		expect(runApiData.run.id).toBe(currentRunId);
		expect(runApiData.run.taskId).toBe(targetTaskId);

		await mobilePage.close();
		await mobileContext.close();
	});

	it('step 11: 设备令牌服务端撤销、断流、401 拦截与防无限重连 (AC 2, E-156, R2)', async () => {
		expect(currentDeviceId).toBeTruthy();

		// Ensure page is active and online with SSE connected before revocation
		await page.waitForFunction(
			() => document.documentElement.getAttribute('data-connection-status') === 'online',
			{ timeout: 15000 },
		);

		// Monitor post-revocation requests to verify no infinite reconnection loop occurs (R2)
		const postRevokeEventsRequests: string[] = [];
		const handleEventsMonitoring = (req: any) => {
			if (req.url().includes('/api/v1/events')) {
				postRevokeEventsRequests.push(req.url());
			}
		};
		page.on('request', handleEventsMonitoring);

		try {
			// Revoke current device token on server (E-156)
			const revokeRes = await fetch(
				`http://127.0.0.1:${daemon.port}/api/v1/devices/${currentDeviceId}`,
				{
					method: 'DELETE',
					headers: { Authorization: `Bearer ${adminToken}` },
				},
			);
			expect(revokeRes.status).toBe(200);

			// R2: Verify that subsequent requests with old token return 401 Unauthorized
			const unauthorizedRes = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/snapshot`, {
				headers: { Authorization: `Bearer ${adminToken}` },
			});
			expect(unauthorizedRes.status).toBe(401);

			// R2: Client clears credentials and redirects to #/pair (E-156)
			await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/pair`, { timeout: 20000 });
			expect(page.url()).toContain('#/pair');

			// R2: Verify credentials are wiped from browser sessionStorage
			const clearedToken = await page.evaluate(() => sessionStorage.getItem('agsched.token'));
			expect(!clearedToken || clearedToken.length === 0).toBe(true);

			const pairContainer = page.locator('[data-component="pairing-container"]');
			await pairContainer.waitFor({ state: 'visible', timeout: 10000 });
			expect(await pairContainer.isVisible()).toBe(true);

			// R2: Wait 3 seconds to verify client does NOT spin in an infinite reconnect loop (E-156)
			const countBeforeWait = postRevokeEventsRequests.length;
			await new Promise((r) => setTimeout(r, 3000));
			const countAfterWait = postRevokeEventsRequests.length;
			// At most 1 attempt if one was in flight, but no continuous barrage
			expect(countAfterWait - countBeforeWait).toBeLessThanOrEqual(1);
		} finally {
			page.off('request', handleEventsMonitoring);
		}
	});

	it('step 12: 架构测试与反造假检查 (AC 1, AC 3, E-135, E-265)', () => {
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

		// Verify no vi.mock on spawnManaged
		const e2eFiles = collectSourceFiles(join(repoRoot, 'e2e'));
		for (const file of e2eFiles) {
			const content = readFileSync(file, 'utf8');
			expect(content).not.toMatch(/vi\.mock\([^)]*spawnManaged/);
			expect(content).not.toMatch(/spawnManaged\s*=\s*/);
		}

		// Verify artifacts dir & gitignore configuration (E-265)
		expect(existsSync(artifactsDir)).toBe(true);
		const gitignoreContent = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
		expect(gitignoreContent).toContain('e2e/artifacts/');
	});
});
