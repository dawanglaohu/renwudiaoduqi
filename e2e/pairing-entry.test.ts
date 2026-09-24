import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '..');
const bootstrapPath = join(repoRoot, 'packages/daemon/bootstrap.mjs');
const artifactsDir = join(repoRoot, 'e2e/artifacts');

function redactSensitiveData(text: string): string {
	return text
		.replace(/(\[daemon\]\s+Initial pairing code:\s*)[A-Za-z0-9]+/gi, '$1[REDACTED]')
		.replace(/("token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
		.replace(/("code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
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

async function startDaemon(): Promise<RunningDaemon> {
	const port = await findAvailablePort();
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-pair-smoke-'));
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');

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
				// Clean shutdown best effort
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
		let stdoutBuf = '';
		let stderrBuf = '';
		child.stdout.on('data', (chunk) => {
			stdoutBuf += chunk.toString();
			try {
				writeFileSync(stdoutPath, stdoutBuf, 'utf8');
			} catch {
				// best effort
			}
		});
		child.stderr.on('data', (chunk) => {
			stderrBuf += chunk.toString();
			try {
				writeFileSync(stderrPath, stderrBuf, 'utf8');
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

	const healthUrl = `http://127.0.0.1:${port}/api/v1/health`;
	let isHealthy = false;
	const deadline = Date.now() + 45000;

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
		await new Promise((r) => setTimeout(r, 200));
	}

	if (existsSync(stdoutPath)) {
		const stdout = readFileSync(stdoutPath, 'utf8');
		const match = stdout.match(/daemon ready pid=(\d+)/);
		if (match?.[1]) {
			daemonPid = Number.parseInt(match[1], 10);
		}
	}

	if (!isHealthy) {
		const outLog = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '';
		const errLog = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
		await stopFn();
		throw new Error(
			`Daemon failed to become healthy at ${healthUrl} within 45s.\nSTDOUT:\n${outLog}\nSTDERR:\n${errLog}`,
		);
	}

	return {
		port,
		dataDir,
		stdoutPath,
		stderrPath,
		getStdout(): string {
			return existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '';
		},
		getStderr(): string {
			return existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
		},
		stop: stopFn,
	};
}

describe('M9-T27 修复生产配对入口并固定真浏览器回归 (AC 1-4, E-06, E-175, E-224, E-226, E-265)', () => {
	let daemon: RunningDaemon;
	let browser: Browser;
	let currentPage: Page | undefined;

	beforeAll(async () => {
		daemon = await startDaemon();
		browser = await chromium.launch({
			headless: true,
			args:
				typeof process.getuid === 'function' && process.getuid() === 0
					? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
					: ['--disable-gpu'],
		});
	});

	afterEach(async ({ task }) => {
		if (task.result?.state === 'fail') {
			mkdirSync(artifactsDir, { recursive: true });
			const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);

			if (currentPage) {
				try {
					await currentPage.screenshot({
						path: join(artifactsDir, `${safeName}-failure.png`),
						fullPage: true,
					});
					const dom = await currentPage.content();
					writeFileSync(
						join(artifactsDir, `${safeName}-dom.html`),
						redactSensitiveData(dom),
						'utf8',
					);
				} catch {
					// best effort artifact capture
				}
			}

			const daemonLogs = [
				'=== DAEMON STDOUT ===',
				redactSensitiveData(daemon.getStdout()),
				'=== DAEMON STDERR ===',
				redactSensitiveData(daemon.getStderr()),
			].join('\n');
			writeFileSync(join(artifactsDir, `${safeName}-daemon.log`), daemonLogs, 'utf8');
		}

		if (currentPage) {
			await currentPage.close().catch(() => {});
			currentPage = undefined;
		}
	});

	afterAll(async () => {
		if (browser) {
			await browser.close().catch(() => {});
		}
		if (daemon) {
			await daemon.stop().catch(() => {});
		}
	});

	it('AC 1 & E-224: clean visit from / normalizes to #/pair and shows operable pairing entry at 1280x800', async () => {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();
		currentPage = page;

		await page.goto(`http://127.0.0.1:${daemon.port}/`);
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/pair`, { timeout: 10000 });

		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/pair`);

		const pairingContainer = page.locator('[data-component="pairing-container"]');
		await pairingContainer.waitFor({ state: 'visible', timeout: 10000 });
		expect(await pairingContainer.isVisible()).toBe(true);

		const containerText = await pairingContainer.innerText();
		expect(containerText.trim()).not.toBe('#/pair');
		expect(containerText.trim().length).toBeGreaterThan(10);

		const codeInput = page.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 5000 });
		expect(await codeInput.isVisible()).toBe(true);
		expect(await codeInput.isEditable()).toBe(true);

		const toggleManualHost = page.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
		}
		const hostInput = page.locator('[data-testid="manual-host-input"]');
		await hostInput.waitFor({ state: 'visible', timeout: 5000 });
		expect(await hostInput.isVisible()).toBe(true);
		expect(await hostInput.isEditable()).toBe(true);

		const submitBtn = page.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
		expect(await submitBtn.isVisible()).toBe(true);
		expect(await submitBtn.isEnabled()).toBe(true);

		await context.close();
		currentPage = undefined;
	});

	it('AC 1 & E-224: clean visit from / normalizes to #/pair and shows operable pairing entry at 390x844 (mobile)', async () => {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
		});
		const page = await context.newPage();
		currentPage = page;

		await page.goto(`http://127.0.0.1:${daemon.port}/`);
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/pair`, { timeout: 10000 });

		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/pair`);

		const pairingContainer = page.locator('[data-component="pairing-container"]');
		await pairingContainer.waitFor({ state: 'visible', timeout: 10000 });
		expect(await pairingContainer.isVisible()).toBe(true);

		const containerText = await pairingContainer.innerText();
		expect(containerText.trim()).not.toBe('#/pair');

		const codeInput = page.locator('[data-testid="pairing-code-input"]');
		await codeInput.waitFor({ state: 'visible', timeout: 5000 });
		expect(await codeInput.isVisible()).toBe(true);
		expect(await codeInput.isEditable()).toBe(true);

		const toggleManualHost = page.getByRole('button', { name: /手填地址/ });
		if (await toggleManualHost.isVisible()) {
			await toggleManualHost.click();
		}
		const hostInput = page.locator('[data-testid="manual-host-input"]');
		await hostInput.waitFor({ state: 'visible', timeout: 5000 });
		expect(await hostInput.isVisible()).toBe(true);
		expect(await hostInput.isEditable()).toBe(true);

		const submitBtn = page.locator('[data-testid="pairing-submit-button"]');
		await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
		expect(await submitBtn.isVisible()).toBe(true);
		expect(await submitBtn.isEnabled()).toBe(true);

		await context.close();
		currentPage = undefined;
	});

	it('AC 3 & E-175: main assets, stylesheet and local font loaded without CDN, and health returns 200', async () => {
		const externalRequests: string[] = [];
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();
		currentPage = page;

		page.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith(`http://127.0.0.1:${daemon.port}`)) {
				externalRequests.push(url);
			}
		});

		await page.goto(`http://127.0.0.1:${daemon.port}/#/pair`);
		await page.waitForLoadState('networkidle');

		expect(externalRequests).toEqual([]);

		const styleLoaded = await page.evaluate(() => document.documentElement.dataset.styleLoaded);
		expect(styleLoaded).toBe('true');

		const pageColor = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--page').trim(),
		);
		expect(pageColor).toBeTruthy();
		expect(pageColor).not.toBe('transparent');

		const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
		expect(bodyBg).toBeTruthy();
		expect(bodyBg).not.toBe('rgba(0, 0, 0, 0)');
		expect(bodyBg).not.toBe('transparent');

		const fontLoaded = await page.evaluate(() => document.fonts.check('14px "Public Sans"'));
		expect(fontLoaded).toBe(true);

		const healthResult = await page.evaluate(async () => {
			const res = await fetch('/api/v1/health');
			return { status: res.status, ok: res.ok, data: await res.json() };
		});
		expect(healthResult.status).toBe(200);
		expect(healthResult.ok).toBe(true);
		expect(healthResult.data).toHaveProperty('ok', true);

		await context.close();
		currentPage = undefined;
	});

	it('AC 2, E-06 & E-226: enters real pairing code, claims token, lands on #/ and invalidates code', async () => {
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

		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();
		currentPage = page;

		await page.goto(`http://127.0.0.1:${daemon.port}/`);
		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/pair`);

		await page.fill('[data-testid="pairing-code-input"]', code);
		await page.click('[data-testid="pairing-submit-button"]');

		await page.waitForURL(`http://127.0.0.1:${daemon.port}/#/`, { timeout: 15000 });
		expect(page.url()).toBe(`http://127.0.0.1:${daemon.port}/#/`);

		const deckContainer = page.locator('[data-component="run-deck-container"]');
		await deckContainer.waitFor({ state: 'visible', timeout: 10000 });
		expect(await deckContainer.isVisible()).toBe(true);

		expect(existsSync(codeFilePath)).toBe(false);

		const secondClaim = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/pair/claim`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, deviceName: 'Unauthorized reuse' }),
		});
		expect(secondClaim.status).toBeGreaterThanOrEqual(400);
		const errBody = (await secondClaim.json()) as { error?: { code?: string } };
		expect(errBody.error?.code).toBe('E_PAIRING_CODE_INVALID');

		await context.close();
		currentPage = undefined;
	});
});
