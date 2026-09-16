import { type ChildProcess, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	buildDaemonStartTarget,
	evaluateStagedProductSupport,
	inspectProductLayers,
	locateBundledRuntime,
	stageInstalledProduct,
} from '../src/artifact-staging.ts';
import {
	executeDaemonSmoke,
	inspectBuildPathResidue,
	resolveStagedLaunchSpec,
} from '../src/staging-smoke.ts';

interface FixtureOptions {
	readonly hostPlatform?: 'win32' | 'darwin' | 'linux';
	readonly arch?: string;
	readonly withRuntime?: boolean;
	readonly withDaemonManifest?: boolean;
	readonly withDaemonEntry?: boolean;
	readonly withPathAdapter?: boolean;
	readonly residue?: string;
}

/**
 * Builds a deployed daemon distribution shaped like the packager output: the daemon
 * entry, its manifest, the platform adapter sources, and an optional bundled Node
 * runtime under `node_modules/node22-<platform>-<arch>/bin`.
 */
function createDistributionFixture(root: string, options: FixtureOptions = {}): string {
	const platform = options.hostPlatform ?? (process.platform as 'win32' | 'darwin' | 'linux');
	const arch = options.arch ?? process.arch;
	const deployDir = join(root, 'deploy');
	mkdirSync(join(deployDir, 'src', 'platform'), { recursive: true });

	if (options.withDaemonManifest !== false) {
		writeFileSync(
			join(deployDir, 'package.json'),
			JSON.stringify({ name: '@agent-scheduler/daemon', type: 'module' }),
			'utf8',
		);
	}
	if (options.withDaemonEntry !== false) {
		writeFileSync(join(deployDir, 'bootstrap.mjs'), 'console.log("daemon");\n', 'utf8');
	}
	if (options.withPathAdapter !== false) {
		writeFileSync(join(deployDir, 'src', 'platform', 'host.ts'), 'export {};\n', 'utf8');
		writeFileSync(join(deployDir, 'src', 'platform', 'lock.ts'), 'export {};\n', 'utf8');
	}
	if (options.withRuntime !== false) {
		const packagePlatform = platform === 'win32' ? 'win' : platform;
		const runtimePackage = join(
			deployDir,
			'node_modules',
			`node22-${packagePlatform}-${arch}`,
			'bin',
		);
		mkdirSync(runtimePackage, { recursive: true });
		writeFileSync(
			join(runtimePackage, platform === 'win32' ? 'node.exe' : 'node'),
			'#!/bin/sh\nexit 1\n',
			'utf8',
		);
	}
	if (options.residue) {
		writeFileSync(
			join(deployDir, 'config.json'),
			JSON.stringify({ path: options.residue }),
			'utf8',
		);
	}
	return deployDir;
}

function makeTempRoot(): string {
	return mkdtempSync(join(tmpdir(), 'agsched-artifact-'));
}

const HOST_PLATFORM = process.platform as 'win32' | 'darwin' | 'linux';

describe('M10-T5: installed product staging (AC 2, E-209, E-257)', () => {
	it('expands the deployed daemon into a path with spaces and non-ASCII characters', () => {
		const root = makeTempRoot();
		try {
			const distribution = createDistributionFixture(root);
			const layout = stageInstalledProduct({
				distribution: { rootDir: distribution },
				rootDir: root,
				hostPlatform: HOST_PLATFORM,
			});

			expect(layout.stageDir).toContain('调度服务 桌面产物 (Unicode & Spaces)');
			expect(layout.stageDir).toContain(' ');
			expect(layout.resourceDir.endsWith('resources')).toBe(true);
			expect(layout.runtimeDir.endsWith('daemon-runtime')).toBe(true);
			expect(layout.daemonEntry).toContain('bootstrap.mjs');
			expect(layout.runtimeExecutable).toContain('runtime');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('refuses to stage a distribution that does not bundle a runtime (E-257)', () => {
		const root = makeTempRoot();
		try {
			const distribution = createDistributionFixture(root, { withRuntime: false });
			expect(() =>
				stageInstalledProduct({
					distribution: { rootDir: distribution },
					rootDir: root,
					hostPlatform: HOST_PLATFORM,
				}),
			).toThrow(/does not bundle a Node runtime/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('locates only the runtime matching the requested platform and architecture', () => {
		const root = makeTempRoot();
		try {
			const distribution = createDistributionFixture(root, { hostPlatform: 'linux', arch: 'x64' });
			expect(locateBundledRuntime({ rootDir: distribution }, 'linux', 'x64')).toBeDefined();
			expect(locateBundledRuntime({ rootDir: distribution }, 'win32', 'x64')).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('derives the frozen launch spec from the expanded coordinates only', () => {
		const root = makeTempRoot();
		try {
			const distribution = createDistributionFixture(root, { hostPlatform: HOST_PLATFORM });
			const layout = stageInstalledProduct({
				distribution: { rootDir: distribution },
				rootDir: root,
				hostPlatform: HOST_PLATFORM,
			});

			const target = buildDaemonStartTarget(layout, { port: 7817 });
			expect(target.launchArguments).toEqual([layout.daemonEntry, '--port', '7817']);

			const spec = resolveStagedLaunchSpec({
				currentExe: layout.currentExe,
				resourceDir: layout.resourceDir,
				hostPlatform: HOST_PLATFORM,
				customDaemonPath: target.runtimeExecutable,
				customArguments: target.launchArguments,
			});

			expect(spec.file).toBe(layout.runtimeExecutable);
			expect(spec.cwd).toBe(layout.resourceDir);
			expect(spec.args).toEqual([layout.daemonEntry, '--port', '7817']);
			expect(spec.file.startsWith(layout.stageDir)).toBe(true);
			expect(Object.isFrozen(spec)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reads product layers from the expanded content and reports the missing ones (E-257)', () => {
		const root = makeTempRoot();
		try {
			const complete = createDistributionFixture(join(root, 'complete'), {
				hostPlatform: HOST_PLATFORM,
			});
			const completeLayout = stageInstalledProduct({
				distribution: { rootDir: complete },
				rootDir: join(root, 'complete-stage'),
				hostPlatform: HOST_PLATFORM,
			});
			const completeEvidence = inspectProductLayers(completeLayout);
			expect(completeEvidence.hasDaemonSupport).toBe(true);
			expect(completeEvidence.hasPathAdapter).toBe(true);
			expect(completeEvidence.hasDesktopShell).toBe(true);
			expect(completeEvidence.missing).toEqual([]);

			const incomplete = createDistributionFixture(join(root, 'incomplete'), {
				hostPlatform: HOST_PLATFORM,
				withDaemonEntry: false,
			});
			const incompleteLayout = stageInstalledProduct({
				distribution: { rootDir: incomplete },
				rootDir: join(root, 'incomplete-stage'),
				hostPlatform: HOST_PLATFORM,
				requireDaemonEntry: false,
			});
			const support = evaluateStagedProductSupport(incompleteLayout, HOST_PLATFORM);
			expect(support.layers.hasDaemonSupport).toBe(false);
			expect(support.missing).toContain('daemon');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('flags build machine paths inside the expanded installation (AC 2, E-209)', () => {
		const root = makeTempRoot();
		try {
			const builderRoot = join(root, 'builder-checkout');
			const clean = createDistributionFixture(join(root, 'clean'));
			const cleanLayout = stageInstalledProduct({
				distribution: { rootDir: clean },
				rootDir: join(root, 'clean-stage'),
				hostPlatform: HOST_PLATFORM,
			});
			expect(inspectBuildPathResidue(cleanLayout.stageDir, [builderRoot]).isClean).toBe(true);

			const dirty = createDistributionFixture(join(root, 'dirty'), { residue: builderRoot });
			const dirtyLayout = stageInstalledProduct({
				distribution: { rootDir: dirty },
				rootDir: join(root, 'dirty-stage'),
				hostPlatform: HOST_PLATFORM,
			});
			const report = inspectBuildPathResidue(dirtyLayout.stageDir, [builderRoot]);
			expect(report.isClean).toBe(false);
			// Paths are compared and reported separator-insensitively.
			expect(report.violations[0]).toContain(builderRoot.replace(/\\/g, '/'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('M10-T5: daemon smoke execution (AC 2, E-265)', () => {
	it('spawns the frozen spec without a shell and waits for the health endpoint', async () => {
		const killMock = vi.fn();
		const spawnMock = vi.fn().mockReturnValue({ pid: 4321, kill: killMock });
		const probeMock = vi.fn().mockResolvedValue(true);
		const spec = Object.freeze({
			file: '/opt/scheduler/resources/daemon-runtime/runtime/node',
			args: Object.freeze([
				'/opt/scheduler/resources/daemon-runtime/bootstrap.mjs',
				'--port',
				'7817',
			]),
			cwd: '/opt/scheduler/resources',
		});

		const outcome = await executeDaemonSmoke(spec, {
			port: 7817,
			timeoutMs: 2000,
			customSpawn: spawnMock as unknown as (
				file: string,
				args: readonly string[],
				opts: { cwd: string; shell: boolean; stdio: 'ignore' | 'pipe' | 'inherit' },
			) => ChildProcess,
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
			customSpawn: spawnMock as unknown as (
				file: string,
				args: readonly string[],
				opts: { cwd: string; shell: boolean; stdio: 'ignore' | 'pipe' | 'inherit' },
			) => ChildProcess,
			probeEndpoint: async () => false,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.error).toContain('Health check probe failed');
	});

	it('resolves a real host executable so the fixtures cannot silently pass', () => {
		const locator = process.platform === 'win32' ? 'where' : 'which';
		const resolved = execFileSync(locator, ['node'], { encoding: 'utf8' })
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		expect(resolved).toBeTruthy();
	});
});
