import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsoluteLaunchPath } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createSimulatedStaging,
	executeDaemonSmoke,
	inspectBuildPathResidue,
	resolveStagedLaunchSpec,
	verifyStagedDeployment,
} from '../src/staging-smoke.ts';

describe('M10-T5: Staging Staged Unpack and Smoke Testing (AC 2, E-209, E-257, E-265)', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), 'agsched-test-staging-'));
	});

	afterEach(() => {
		try {
			rmSync(tempRoot, { recursive: true, force: true });
		} catch {
			// Ignore cleanup
		}
	});

	it('AC 2 & E-209: creates staging layout in temporary root with spaces and Unicode', () => {
		const staging = createSimulatedStaging({
			rootDir: tempRoot,
			hostPlatform: 'win32',
		});

		expect(staging.stageDir).toContain('调度服务 桌面产物 (Unicode & Spaces)');
		expect(isAbsoluteLaunchPath(staging.currentExe)).toBe(true);
		expect(isAbsoluteLaunchPath(staging.resourceDir)).toBe(true);
		expect(isAbsoluteLaunchPath(staging.daemonFile)).toBe(true);
		expect(isAbsoluteLaunchPath(staging.stubScriptFile)).toBe(true);
		expect(staging.currentExe.endsWith('scheduler.exe')).toBe(true);
		expect(staging.daemonFile.endsWith('daemon.exe')).toBe(true);
		expect(staging.stubScriptFile.endsWith('daemon-smoke-stub.mjs')).toBe(true);
	});

	it('AC 2 & E-209: resolves absolute frozen DaemonLaunchSpec from staged layout', () => {
		const staging = createSimulatedStaging({
			rootDir: tempRoot,
			hostPlatform: 'linux',
		});

		const spec = resolveStagedLaunchSpec({
			currentExe: staging.currentExe,
			resourceDir: staging.resourceDir,
			hostPlatform: 'linux',
			customArguments: ['--port', '7817'],
		});

		expect(spec.file).toBe(staging.daemonFile);
		expect(spec.cwd).toBe(staging.resourceDir);
		expect(spec.args).toEqual(['--port', '7817']);
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.args)).toBe(true);
		expect(isAbsoluteLaunchPath(spec.file)).toBe(true);
		expect(isAbsoluteLaunchPath(spec.cwd)).toBe(true);
	});

	it('AC 2: inspectBuildPathResidue detects hardcoded builder machine paths', () => {
		const staging = createSimulatedStaging({ rootDir: tempRoot });

		// Clean staging
		const cleanReport = inspectBuildPathResidue(staging.stageDir, [
			'/home/runner/work',
			'C:\\Users\\runneradmin',
		]);
		expect(cleanReport.isClean).toBe(true);
		expect(cleanReport.violations).toHaveLength(0);

		// Contaminated staging
		const contaminatedFile = join(staging.resourceDir, 'contaminated.json');
		writeFileSync(
			contaminatedFile,
			JSON.stringify({ builderPath: '/home/runner/work/repo/binary' }),
			'utf8',
		);

		const dirtyReport = inspectBuildPathResidue(staging.stageDir, [
			'/home/runner/work',
			'C:\\Users\\runneradmin',
		]);
		expect(dirtyReport.isClean).toBe(false);
		expect(dirtyReport.violations.length).toBeGreaterThan(0);
		expect(dirtyReport.violations[0]).toContain('/home/runner/work');
	});

	it('AC 2 & E-265: executeDaemonSmoke executes child process with exact file/args/cwd and verifies health check', async () => {
		const staging = createSimulatedStaging({ rootDir: tempRoot, hostPlatform: 'linux' });
		const spec = resolveStagedLaunchSpec({
			currentExe: staging.currentExe,
			resourceDir: staging.resourceDir,
			hostPlatform: 'linux',
			customArguments: ['--port', '7817'],
		});

		const killMock = vi.fn();
		const spawnMock = vi.fn().mockReturnValue({
			pid: 4321,
			kill: killMock,
		});

		const probeMock = vi.fn().mockResolvedValue(true);

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
		expect(outcome.endpointStatus).toBe(200);

		// Assert spawn parameters
		expect(spawnMock).toHaveBeenCalledWith(spec.file, spec.args, {
			cwd: spec.cwd,
			shell: false,
			stdio: 'ignore',
		});
		expect(probeMock).toHaveBeenCalledWith('http://127.0.0.1:7817/api/v1/health');
		expect(killMock).toHaveBeenCalledWith('SIGTERM');
	});

	it('AC 2 & E-257: verifyStagedDeployment asserts product layer completeness and blocks when a layer is missing', async () => {
		// Incomplete platform layers (missing desktop shell) -> fails
		const incompleteReport = await verifyStagedDeployment({
			rootDir: tempRoot,
			hostPlatform: 'linux',
			layers: {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: false,
			},
		});

		expect(incompleteReport.passed).toBe(false);
		expect(incompleteReport.errors.some((e) => e.includes('E-257'))).toBe(true);

		// Complete platform layers -> passes
		const completeReport = await verifyStagedDeployment({
			rootDir: tempRoot,
			hostPlatform: 'win32',
			layers: {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
			},
			executeSmoke: true,
			smokeOptions: {
				customSpawn: () => ({ pid: 1111, kill: () => true }) as unknown as ChildProcess,
				probeEndpoint: async () => true,
			},
		});

		expect(completeReport.passed).toBe(true);
		expect(completeReport.stageLayout.stageDir).toContain('调度服务 桌面产物');
		expect(completeReport.pathResidueClean).toBe(true);
		expect(completeReport.smokeOutcome?.success).toBe(true);
	});
});
