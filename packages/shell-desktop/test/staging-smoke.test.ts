import type { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_STAGING_FOLDER,
	evaluateStagedProductSupport,
	inspectProductLayers,
	stageInstalledProduct,
} from '../src/artifact-staging.ts';
import { stageTauriBundle } from '../src/bundle-staging.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';
import {
	executeDaemonSmoke,
	inspectBuildPathResidue,
	resolveStagedLaunchSpec,
} from '../src/staging-smoke.ts';

const HOST_PLATFORM: 'win32' | 'darwin' | 'linux' =
	process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';

interface FixtureOptions {
	readonly withRuntime?: boolean;
	readonly withDaemonManifest?: boolean;
	readonly withDaemonEntry?: boolean;
	readonly withPathAdapter?: boolean;
	readonly withWebDist?: boolean;
	readonly withShellBinary?: boolean;
	readonly residue?: string;
	/** Source of `bootstrap.mjs`; the default only prints and exits. */
	readonly daemonEntrySource?: string;
	/** Copies the host Node into `runtime/` so the entry really executes. */
	readonly realRuntime?: boolean;
}

interface Fixture {
	readonly daemonDistributionDir: string;
	readonly webDistDir: string;
	readonly desktopShellBinary: string;
}

/**
 * Builds packager output shaped like `build-daemon-distribution.mjs` + `cargo build`:
 * the daemon entry, its manifest, the platform adapter sources, the runtime under
 * `runtime/`, the web build, and the shell executable.
 */
function createFixture(root: string, options: FixtureOptions = {}): Fixture {
	const daemonDistributionDir = join(root, 'daemon-runtime');
	const webDistDir = join(root, 'web', 'dist');
	const desktopShellBinary = join(
		root,
		HOST_PLATFORM === 'win32' ? 'desktop-shell.exe' : 'desktop-shell',
	);
	mkdirSync(join(daemonDistributionDir, 'src', 'platform'), { recursive: true });

	if (options.withDaemonManifest !== false) {
		writeFileSync(
			join(daemonDistributionDir, 'package.json'),
			JSON.stringify({ name: '@agent-scheduler/daemon', type: 'module' }),
			'utf8',
		);
	}
	if (options.withDaemonEntry !== false) {
		writeFileSync(
			join(daemonDistributionDir, 'bootstrap.mjs'),
			options.daemonEntrySource ?? 'console.log("daemon");\n',
			'utf8',
		);
	}
	if (options.withPathAdapter !== false) {
		writeFileSync(join(daemonDistributionDir, 'src', 'platform', 'host.ts'), 'export {};\n');
		writeFileSync(join(daemonDistributionDir, 'src', 'platform', 'lock.ts'), 'export {};\n');
	}
	if (options.withRuntime !== false) {
		const runtimeDir = join(daemonDistributionDir, 'runtime');
		mkdirSync(runtimeDir, { recursive: true });
		const runtime = join(runtimeDir, HOST_PLATFORM === 'win32' ? 'node.exe' : 'node');
		if (options.realRuntime) {
			cpSync(process.execPath, runtime);
		} else {
			writeFileSync(runtime, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
		}
	}
	if (options.withWebDist !== false) {
		mkdirSync(webDistDir, { recursive: true });
		writeFileSync(join(webDistDir, 'index.html'), '<!doctype html><title>ui</title>\n');
	}
	if (options.withShellBinary !== false) {
		writeFileSync(desktopShellBinary, 'shell executable placeholder\n', { mode: 0o755 });
	}
	if (options.residue) {
		writeFileSync(
			join(daemonDistributionDir, 'config.json'),
			JSON.stringify({ path: options.residue }),
			'utf8',
		);
	}
	return { daemonDistributionDir, webDistDir, desktopShellBinary };
}

function makeTempRoot(): string {
	return mkdtempSync(join(tmpdir(), 'agsched-artifact-'));
}

function stage(root: string, fixture: Fixture, stageRoot = join(root, 'stage')) {
	return stageInstalledProduct({
		sources: fixture,
		rootDir: stageRoot,
		hostPlatform: HOST_PLATFORM,
	});
}

/** A daemon entry that serves the health endpoint on the port the product env names. */
const HEALTH_STUB_ENTRY = [
	'import { createServer } from "node:http";',
	'const port = Number.parseInt(process.env.AGSCHED_PORT ?? "", 10);',
	'if (!Number.isInteger(port)) { console.error("AGSCHED_PORT missing"); process.exit(1); }',
	'createServer((req, res) => {',
	'  if (req.url === "/api/v1/health") { res.writeHead(200); res.end("{}"); return; }',
	'  res.writeHead(404); res.end();',
	'}).listen(port, "127.0.0.1");',
	'',
].join('\n');

describe('M10-T5: installed product staging (AC 2, E-209, E-257)', () => {
	it.skipIf(process.platform !== 'linux')(
		'expands a real deb installer and derives current_exe/resource_dir from installed files',
		() => {
			const root = makeTempRoot();
			try {
				const packageRoot = join(root, 'package');
				const appRoot = join(packageRoot, 'usr', 'lib', 'agent-scheduler');
				const resourceDir = join(appRoot, 'resources');
				const daemonDir = join(resourceDir, 'daemon-runtime');
				mkdirSync(join(packageRoot, 'DEBIAN'), { recursive: true });
				mkdirSync(join(appRoot, 'resources', 'daemon-runtime', 'runtime'), { recursive: true });
				mkdirSync(join(resourceDir, 'web', 'dist'), { recursive: true });
				writeFileSync(
					join(packageRoot, 'DEBIAN', 'control'),
					'Package: agent-scheduler-test\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: test\nDescription: test\n',
				);
				writeFileSync(join(appRoot, 'desktop-shell'), 'shell', { mode: 0o755 });
				writeFileSync(join(daemonDir, 'bootstrap.mjs'), 'export {};\n');
				writeFileSync(join(daemonDir, 'runtime', 'node'), 'node', { mode: 0o755 });
				writeFileSync(join(daemonDir, 'package.json'), '{"name":"@agent-scheduler/daemon"}\n');
				writeFileSync(join(resourceDir, 'web', 'dist', 'index.html'), '<!doctype html>\n');

				const bundlePath = join(root, 'agent-scheduler-test.deb');
				execFileSync('dpkg-deb', ['--build', packageRoot, bundlePath], { stdio: 'pipe' });
				const layout = stageTauriBundle({
					bundlePath,
					rootDir: join(root, 'expanded'),
					hostPlatform: 'linux',
				});

				expect(layout.stageDir).toContain('Unicode & Spaces');
				expect(layout.currentExe).toBe(
					join(layout.stageDir, 'usr', 'lib', 'agent-scheduler', 'desktop-shell'),
				);
				expect(layout.resourceDir).toBe(
					join(layout.stageDir, 'usr', 'lib', 'agent-scheduler', 'resources'),
				);
				expect(layout.daemonEntry).toBe(
					join(layout.resourceDir, 'daemon-runtime', 'bootstrap.mjs'),
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it('expands the packager output into a path with spaces and non-ASCII characters', () => {
		const root = makeTempRoot();
		try {
			const layout = stage(root, createFixture(root));
			expect(layout.stageDir).toContain(DEFAULT_STAGING_FOLDER);
			expect(layout.stageDir).toContain(' ');
			expect(layout.resourceDir).toBe(join(layout.stageDir, 'resources'));
			expect(existsSync(layout.daemonEntry)).toBe(true);
			expect(existsSync(layout.runtimeExecutable)).toBe(true);
			expect(existsSync(join(layout.webDistDir, 'index.html'))).toBe(true);
			expect(existsSync(layout.currentExe)).toBe(true);
			// The web build sits where the daemon's static plugin resolves it from the
			// daemon-runtime source layout: `<daemon-runtime>/../web/dist`.
			expect(layout.webDistDir).toBe(join(layout.resourceDir, 'web', 'dist'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('resolves the frozen launch spec from the expanded coordinates exactly as the shell does', () => {
		const root = makeTempRoot();
		try {
			const layout = stage(root, createFixture(root));
			const spec = resolveLaunchSpec({
				currentExe: layout.currentExe,
				resourceDir: layout.resourceDir,
				hostPlatform: HOST_PLATFORM,
			});
			expect(spec.file).toBe(layout.runtimeExecutable);
			expect(spec.args).toEqual([layout.daemonEntry]);
			expect(spec.cwd).toBe(layout.resourceDir);
			expect(spec.file.startsWith(layout.stageDir)).toBe(true);
			expect(Object.isFrozen(spec)).toBe(true);

			const validated = resolveStagedLaunchSpec({
				currentExe: layout.currentExe,
				resourceDir: layout.resourceDir,
				hostPlatform: HOST_PLATFORM,
			});
			expect(validated).toEqual(spec);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reads every product layer from the expanded files and names what is missing (E-257)', () => {
		const root = makeTempRoot();
		try {
			const complete = inspectProductLayers(stage(root, createFixture(join(root, 'ok'))));
			expect(complete).toEqual({
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
				missing: [],
			});

			const noRuntime = evaluateStagedProductSupport(
				stage(
					root,
					createFixture(join(root, 'no-runtime'), { withRuntime: false }),
					join(root, 's1'),
				),
				HOST_PLATFORM,
			);
			expect(noRuntime.layers.hasDaemonSupport).toBe(false);
			expect(noRuntime.missing.join(';')).toContain('daemon-runtime/runtime/node');

			const noWebDist = evaluateStagedProductSupport(
				stage(root, createFixture(join(root, 'no-web'), { withWebDist: false }), join(root, 's2')),
				HOST_PLATFORM,
			);
			expect(noWebDist.layers.hasDaemonSupport).toBe(false);
			expect(noWebDist.missing.join(';')).toContain('web/dist/index.html');

			const noShell = evaluateStagedProductSupport(
				stage(
					root,
					createFixture(join(root, 'no-shell'), { withShellBinary: false }),
					join(root, 's3'),
				),
				HOST_PLATFORM,
			);
			expect(noShell.layers.hasDesktopShell).toBe(false);
			expect(noShell.missing.join(';')).toContain('desktop-shell');

			const noAdapter = evaluateStagedProductSupport(
				stage(
					root,
					createFixture(join(root, 'no-adapter'), { withPathAdapter: false }),
					join(root, 's4'),
				),
				HOST_PLATFORM,
			);
			expect(noAdapter.layers.hasPathAdapter).toBe(false);
			expect(noAdapter.missing.join(';')).toContain('path-adapter');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('flags build machine paths inside the expanded installation (AC 2, E-209)', () => {
		const root = makeTempRoot();
		try {
			const builderRoot = join(root, 'builder-checkout');
			const clean = stage(root, createFixture(join(root, 'clean')), join(root, 'clean-stage'));
			expect(inspectBuildPathResidue(clean.stageDir, [builderRoot]).isClean).toBe(true);

			const dirty = stage(
				root,
				createFixture(join(root, 'dirty'), { residue: builderRoot }),
				join(root, 'dirty-stage'),
			);
			const report = inspectBuildPathResidue(dirty.stageDir, [builderRoot]);
			expect(report.isClean).toBe(false);
			// Paths are compared and reported separator-insensitively.
			expect(report.violations[0]).toContain(builderRoot.replace(/\\/g, '/'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === 'win32')(
		'skips the DMG Applications symlink when checking packaged files',
		() => {
			const root = makeTempRoot();
			try {
				writeFileSync(join(root, 'product.json'), JSON.stringify({ product: 'desktop' }));
				symlinkSync(root, join(root, 'Applications'), 'dir');
				expect(inspectBuildPathResidue(root, [join(root, 'builder-checkout')]).isClean).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

describe('M10-T5: daemon smoke execution (AC 2, E-265)', () => {
	it('spawns the frozen spec without a shell and waits for the health endpoint', async () => {
		const killMock = vi.fn();
		const spawnMock = vi.fn().mockReturnValue({ pid: 4321, kill: killMock });
		const probeMock = vi.fn().mockResolvedValue(true);
		const spec = Object.freeze({
			file: '/opt/scheduler/resources/daemon-runtime/runtime/node',
			args: Object.freeze(['/opt/scheduler/resources/daemon-runtime/bootstrap.mjs']),
			cwd: '/opt/scheduler/resources',
		});

		const outcome = await executeDaemonSmoke(spec, {
			port: 7817,
			timeoutMs: 2000,
			customSpawn: spawnMock as unknown as typeof spawn,
			probeEndpoint: probeMock,
		});

		expect(outcome.success).toBe(true);
		expect(outcome.pid).toBe(4321);
		expect(spawnMock).toHaveBeenCalledWith(spec.file, spec.args, {
			cwd: spec.cwd,
			shell: false,
			stdio: 'ignore',
		});
		expect(probeMock).toHaveBeenCalledWith('http://127.0.0.1:7817/api/v1/health');
		expect(killMock).toHaveBeenCalledWith('SIGTERM');
	});

	it('fails when the launch target cannot be started (negative case)', async () => {
		const missingTarget = join(makeTempRoot(), 'does-not-exist', 'node');
		const outcome = await executeDaemonSmoke(
			Object.freeze({ file: missingTarget, args: Object.freeze([]), cwd: tmpdir() }),
			{ port: 7899, timeoutMs: 1500 },
		);

		expect(outcome.success).toBe(false);
		expect(outcome.error).toBeTruthy();
	});

	it('fails when the health endpoint never answers even though the process started', async () => {
		const spawnMock = vi.fn().mockReturnValue({ pid: 777, kill: vi.fn() });
		const spec = Object.freeze({
			file: process.execPath,
			args: Object.freeze(['-e', 'setTimeout(() => {}, 60000)']),
			cwd: tmpdir(),
		});

		const outcome = await executeDaemonSmoke(spec, {
			port: 7898,
			timeoutMs: 1500,
			customSpawn: spawnMock as unknown as typeof spawn,
			probeEndpoint: async () => false,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.error).toContain('Health check probe failed');
	});

	it(
		'really starts the expanded entry through the shipped runtime with the product env (AC 2)',
		{ timeout: 30_000 },
		async () => {
			const root = makeTempRoot();
			try {
				const layout = stage(
					root,
					createFixture(root, { realRuntime: true, daemonEntrySource: HEALTH_STUB_ENTRY }),
				);
				const spec = resolveLaunchSpec({
					currentExe: layout.currentExe,
					resourceDir: layout.resourceDir,
					hostPlatform: HOST_PLATFORM,
				});
				const port = 7900 + Math.floor(Math.random() * 500);
				const outcome = await executeDaemonSmoke(spec, {
					port,
					timeoutMs: 15_000,
					env: { ...(process.env as Record<string, string>), AGSCHED_PORT: String(port) },
				});
				expect(outcome.error).toBeUndefined();
				expect(outcome.success).toBe(true);
				expect(outcome.endpointStatus).toBe(200);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it(
		'reports the exit code when the shipped entry dies before becoming healthy',
		{ timeout: 30_000 },
		async () => {
			const root = makeTempRoot();
			try {
				const layout = stage(
					root,
					createFixture(root, {
						realRuntime: true,
						daemonEntrySource: 'console.error("refusing to start"); process.exit(3);\n',
					}),
				);
				const spec = resolveLaunchSpec({
					currentExe: layout.currentExe,
					resourceDir: layout.resourceDir,
					hostPlatform: HOST_PLATFORM,
				});
				const outcome = await executeDaemonSmoke(spec, { port: 7897, timeoutMs: 15_000 });
				expect(outcome.success).toBe(false);
				expect(outcome.error).toContain('exited with code 3');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
