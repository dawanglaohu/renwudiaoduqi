import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	SHELL_SMOKE_ENV,
	SHELL_SMOKE_POLL_INTERVAL_MS,
	SHELL_SMOKE_TIMEOUT_MS,
	SHELL_SMOKE_TOKEN_ENV,
	type ShellSpawnFunction,
	claimSmokeDeviceToken,
	executeShellSmokeCheck,
	readPairingCode,
	resolveShellSmokeLaunchPlan,
	resolveSmokeStage,
} from '../launchers/smoke-runner.ts';
import { DEFAULT_STAGING_FOLDER } from '../src/artifact-staging.ts';
import type { SpawnOptionsInjection } from '../src/daemon-process.ts';

const packageDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const libRs = readFileSync(resolve(packageDir, 'src-tauri', 'src', 'lib.rs'), 'utf8');

const HOST_PLATFORM =
	process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

function makeTempRoot(): string {
	return mkdtempSync(join(tmpdir(), 'agsched-shell-smoke-'));
}

function removeTempRoot(root: string): void {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Cleanup is best effort: the sandbox in some environments refuses recursive deletes.
	}
}

describe('M10-T6 AC 2: host hint contract', () => {
	it('returns http://127.0.0.1:<port> instead of a tauri origin', () => {
		// The hint is what stops resolveBaseUrl() from falling through to tauri://localhost.
		expect(libRs).toContain('format!("http://127.0.0.1:{}", resolve_daemon_port())');
	});

	it('reads AGSCHED_PORT with the daemon default of 7817', () => {
		expect(libRs).toContain('const PORT_ENV: &str = "AGSCHED_PORT";');
		expect(libRs).toContain('const DEFAULT_DAEMON_PORT: u16 = 7817;');
		// A malformed value is reported and falls back instead of silently producing a bad URL.
		expect(libRs).toContain('is not a TCP port number');
	});
});

describe('M10-T6 AC 3: shell smoke mode stays in lockstep with the Rust side', () => {
	it('pins the env names, poll cadence and ceiling the shell reads', () => {
		expect(SHELL_SMOKE_ENV).toBe('AGSCHED_SMOKE');
		expect(SHELL_SMOKE_TOKEN_ENV).toBe('AGSCHED_SMOKE_TOKEN');
		expect(SHELL_SMOKE_POLL_INTERVAL_MS).toBe(500);
		expect(SHELL_SMOKE_TIMEOUT_MS).toBe(20_000);

		expect(libRs).toContain('const SMOKE_ENV: &str = "AGSCHED_SMOKE";');
		expect(libRs).toContain('const SMOKE_TOKEN_ENV: &str = "AGSCHED_SMOKE_TOKEN";');
		expect(libRs).toContain('const SMOKE_POLL_INTERVAL_MS: u64 = 500;');
		expect(libRs).toContain('const SMOKE_TIMEOUT_MS: u64 = 20_000;');
	});

	it('reads the two DOM values the web bundle publishes, and reports them back', () => {
		// The values M9-T24 / M9-T26 publish on <html>; a rename on either side breaks this.
		expect(libRs).toContain('document.documentElement');
		expect(libRs).toContain('styleLoaded');
		expect(libRs).toContain('connectionStatus');
		expect(libRs).toContain("invoke('report_smoke_probe'");
		expect(libRs).toContain('fn report_smoke_probe(');
		// Failing prints both values so a red CI run is diagnosable (AC 3).
		expect(libRs).toContain('FAILED after {}ms: styleLoaded=\\"{}\\" connectionStatus=\\"{}\\"');
	});

	it('reads the token from the harness only while smoke mode is on', () => {
		expect(libRs).toContain('if smoke_enabled() {');
		expect(libRs).toContain('keyring::Entry::new(SERVICE_NAME, TOKEN_USER)');
	});
});

describe('M10-T6 AC 3: shell launch plan', () => {
	it('runs the shell under xvfb-run on Linux', () => {
		const plan = resolveShellSmokeLaunchPlan({
			hostPlatform: 'linux',
			shellBinary: '/opt/agsched/desktop-shell',
			port: 7817,
			token: 'tok',
			dataDir: '/tmp/data',
		});
		expect(plan.file).toBe('xvfb-run');
		expect(plan.args).toEqual(['-a', '/opt/agsched/desktop-shell']);
		expect(plan.env[SHELL_SMOKE_ENV]).toBe('1');
		expect(plan.env[SHELL_SMOKE_TOKEN_ENV]).toBe('tok');
		expect(plan.env.AGSCHED_PORT).toBe('7817');
		expect(plan.env.AGSCHED_DATA_DIR).toBe('/tmp/data');
	});

	it('starts the shell executable directly on Windows and macOS', () => {
		for (const platform of ['win32', 'darwin'] as const) {
			const plan = resolveShellSmokeLaunchPlan({
				hostPlatform: platform,
				shellBinary: platform === 'win32' ? 'C:\\Program Files\\shell.exe' : '/Applications/x',
				port: 7900,
				token: 'tok',
				dataDir: '/tmp/data',
			});
			expect(plan.file).toBe(
				platform === 'win32' ? 'C:\\Program Files\\shell.exe' : '/Applications/x',
			);
			expect(plan.args).toEqual([]);
			expect(plan.env.AGSCHED_PORT).toBe('7900');
		}
	});

	it('selects the stage from the command line, defaulting to staging', () => {
		expect(resolveSmokeStage([])).toBe('staging');
		expect(resolveSmokeStage(['staging'])).toBe('staging');
		expect(resolveSmokeStage(['shell'])).toBe('shell');
	});
});

describe('M10-T6 AC 3: pairing a real device for the smoke', () => {
	it('reads the pairing code the daemon writes next to its data directory', async () => {
		const root = makeTempRoot();
		try {
			writeFileSync(join(root, 'pairing-code.txt'), 'PAIR-1234\n');
			await expect(readPairingCode(root, 500)).resolves.toBe('PAIR-1234');
		} finally {
			removeTempRoot(root);
		}
	});

	it('fails with the file path when the daemon never writes a code', async () => {
		const root = makeTempRoot();
		try {
			await expect(readPairingCode(root, 300)).rejects.toThrow(/pairing code/);
		} finally {
			removeTempRoot(root);
		}
	});

	it('claims a token through the real endpoint and refuses a response without one', async () => {
		const seen: Array<{ url?: string; body?: string }> = [];
		const server = createServer((request, response) => {
			let body = '';
			request.on('data', (chunk) => {
				body += String(chunk);
			});
			request.on('end', () => {
				seen.push({ url: request.url, body });
				if (request.url === '/api/v1/pair/claim' && body.includes('PAIR-1234')) {
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ deviceId: 'dev-1', token: 'token-abc' }));
					return;
				}
				response.writeHead(401, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ error: { code: 'E_PAIRING_CODE_INVALID' } }));
			});
		});
		const port = await listen(server);
		try {
			const baseUrl = `http://127.0.0.1:${port}`;
			await expect(claimSmokeDeviceToken({ baseUrl, code: 'PAIR-1234' })).resolves.toBe(
				'token-abc',
			);
			expect(seen[0]?.url).toBe('/api/v1/pair/claim');
			expect(seen[0]?.body).toContain('desktop-shell-smoke');
			await expect(claimSmokeDeviceToken({ baseUrl, code: 'WRONG' })).rejects.toThrow(/HTTP 401/);
		} finally {
			await close(server);
		}
	});
});

interface FakeChild {
	readonly pid: number;
	unref(): void;
	kill(): boolean;
	once(event: string, listener: (...args: unknown[]) => void): FakeChild;
}

function fakeChild(pid: number, onExit?: (code: number) => void): FakeChild {
	const child: FakeChild = {
		pid,
		unref: () => {},
		kill: () => true,
		once: (event, listener) => {
			if (event === 'exit' && onExit) {
				listener(onExit(0));
			}
			return child;
		},
	};
	return child;
}

function listen(server: Server): Promise<number> {
	return new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				rejectListen(new Error('server did not expose a TCP address'));
				return;
			}
			resolveListen(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolveClose) => {
		server.close(() => resolveClose());
	});
}

describe('M10-T6 AC 3: the shell stage end to end', () => {
	it('starts the shipped daemon, pairs, then starts the shell with AGSCHED_SMOKE=1', async () => {
		const root = makeTempRoot();
		const distribution = join(root, 'distribution');
		const webDist = join(root, 'web-dist');
		const shellBinary = join(
			root,
			HOST_PLATFORM === 'win32' ? 'desktop-shell.exe' : 'desktop-shell',
		);
		const claimedBodies: string[] = [];
		let healthHits = 0;
		interface CapturedPlan {
			readonly file: string;
			readonly args: readonly string[];
			readonly env: Record<string, string>;
		}
		const captured: { plan: CapturedPlan | null } = { plan: null };

		try {
			mkdirSync(join(distribution, 'runtime'), { recursive: true });
			mkdirSync(join(distribution, 'src', 'platform'), { recursive: true });
			mkdirSync(webDist, { recursive: true });
			writeFileSync(
				join(distribution, 'package.json'),
				JSON.stringify({ name: '@agent-scheduler/daemon' }),
			);
			writeFileSync(join(distribution, 'bootstrap.mjs'), '// shipped entry');
			writeFileSync(
				join(distribution, 'runtime', HOST_PLATFORM === 'win32' ? 'node.exe' : 'node'),
				'',
			);
			writeFileSync(join(distribution, 'src', 'platform', 'host.ts'), '');
			writeFileSync(join(distribution, 'src', 'platform', 'lock.ts'), '');
			writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
			writeFileSync(shellBinary, '');

			const server = createServer((request, response) => {
				if (request.url === '/api/v1/health') {
					healthHits += 1;
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end('{"status":"ok"}');
					return;
				}
				let body = '';
				request.on('data', (chunk) => {
					body += String(chunk);
				});
				request.on('end', () => {
					claimedBodies.push(body);
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ deviceId: 'dev-1', token: 'smoke-token' }));
				});
			});
			const port = await listen(server);

			const stageRoot = join(root, 'stage-root');
			mkdirSync(stageRoot, { recursive: true });
			const dataDir = join(stageRoot, DEFAULT_STAGING_FOLDER, 'shell-smoke-data');

			try {
				const result = await executeShellSmokeCheck({
					rootDir: stageRoot,
					daemonDistributionDir: distribution,
					webDistDir: webDist,
					desktopShellBinary: shellBinary,
					hostPlatform: HOST_PLATFORM,
					port,
					probeTimeoutMs: 5_000,
					customDaemonSpawn: ((file: string, args: readonly string[]) => {
						// The real daemon writes this at boot; the double stands in for it.
						mkdirSync(dataDir, { recursive: true });
						writeFileSync(join(dataDir, 'pairing-code.txt'), 'PAIR-SMOKE');
						expect(file).toContain(HOST_PLATFORM === 'win32' ? 'node.exe' : 'node');
						expect(args[0]).toContain('bootstrap.mjs');
						return fakeChild(999_999) as unknown as ChildProcess;
					}) as SpawnOptionsInjection['spawn'],
					customShellSpawn: ((
						file: string,
						args: readonly string[],
						options: { env: Record<string, string> },
					) => {
						captured.plan = { file, args, env: { ...options.env } };
						return fakeChild(999_998, () => 0) as unknown as ChildProcess;
					}) as ShellSpawnFunction,
				});

				expect(result.ok, result.message).toBe(true);
				expect(healthHits).toBeGreaterThan(0);
				expect(claimedBodies[0]).toContain('PAIR-SMOKE');
				expect(captured.plan?.env[SHELL_SMOKE_ENV]).toBe('1');
				expect(captured.plan?.env[SHELL_SMOKE_TOKEN_ENV]).toBe('smoke-token');
				expect(captured.plan?.env.AGSCHED_PORT).toBe(String(port));
				// The shell is started from the expanded installation, not from the source path.
				const expectedShellName = HOST_PLATFORM === 'win32' ? 'desktop-shell.exe' : 'desktop-shell';
				if (HOST_PLATFORM === 'linux') {
					expect(captured.plan?.file).toBe('xvfb-run');
					expect(captured.plan?.args[1]).toContain(expectedShellName);
				} else {
					expect(captured.plan?.file).toContain(expectedShellName);
					expect(captured.plan?.file).toContain('stage-root');
				}
			} finally {
				await close(server);
			}
		} finally {
			removeTempRoot(root);
		}
	}, 30_000);

	it('refuses to run when the daemon distribution is missing (E-257)', async () => {
		const root = makeTempRoot();
		try {
			const result = await executeShellSmokeCheck({
				rootDir: root,
				daemonDistributionDir: join(root, 'nope'),
				webDistDir: join(root, 'nope-web'),
				desktopShellBinary: join(root, 'nope-shell'),
				hostPlatform: HOST_PLATFORM,
			});
			expect(result.ok).toBe(false);
			expect(result.message).toContain('daemon distribution does not exist');
		} finally {
			removeTempRoot(root);
		}
	});

	it('fails the stage when the shell exits non-zero', async () => {
		const root = makeTempRoot();
		const distribution = join(root, 'distribution');
		const webDist = join(root, 'web-dist');
		const shellBinary = join(
			root,
			HOST_PLATFORM === 'win32' ? 'desktop-shell.exe' : 'desktop-shell',
		);
		try {
			mkdirSync(join(distribution, 'runtime'), { recursive: true });
			mkdirSync(join(distribution, 'src', 'platform'), { recursive: true });
			mkdirSync(webDist, { recursive: true });
			writeFileSync(
				join(distribution, 'package.json'),
				JSON.stringify({ name: '@agent-scheduler/daemon' }),
			);
			writeFileSync(join(distribution, 'bootstrap.mjs'), '');
			writeFileSync(
				join(distribution, 'runtime', HOST_PLATFORM === 'win32' ? 'node.exe' : 'node'),
				'',
			);
			writeFileSync(join(distribution, 'src', 'platform', 'host.ts'), '');
			writeFileSync(join(distribution, 'src', 'platform', 'lock.ts'), '');
			writeFileSync(join(webDist, 'index.html'), '<!doctype html>');
			writeFileSync(shellBinary, '');

			const server = createServer((request, response) => {
				let body = '';
				request.on('data', (chunk) => {
					body += String(chunk);
				});
				request.on('end', () => {
					void body;
					response.writeHead(200, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ deviceId: 'dev-1', token: 'smoke-token' }));
				});
			});
			const port = await listen(server);
			const stageRoot = join(root, 'stage-root');
			mkdirSync(stageRoot, { recursive: true });
			const dataDir = join(stageRoot, DEFAULT_STAGING_FOLDER, 'shell-smoke-data');

			try {
				const result = await executeShellSmokeCheck({
					rootDir: stageRoot,
					daemonDistributionDir: distribution,
					webDistDir: webDist,
					desktopShellBinary: shellBinary,
					hostPlatform: HOST_PLATFORM,
					port,
					probeTimeoutMs: 5_000,
					customDaemonSpawn: (() => {
						mkdirSync(dataDir, { recursive: true });
						writeFileSync(join(dataDir, 'pairing-code.txt'), 'PAIR-SMOKE');
						return fakeChild(999_997) as unknown as ChildProcess;
					}) as SpawnOptionsInjection['spawn'],
					customShellSpawn: (() =>
						fakeChild(999_996, () => 1) as unknown as ChildProcess) as ShellSpawnFunction,
				});

				expect(result.ok).toBe(false);
				expect(result.message).toContain('exited with code 1');
			} finally {
				await close(server);
			}
		} finally {
			removeTempRoot(root);
		}
	}, 30_000);
});
