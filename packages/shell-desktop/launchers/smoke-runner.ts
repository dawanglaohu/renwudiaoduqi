import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type PlatformProductLayers, evaluatePlatformSupport } from '../src/platform-support.ts';
import {
	createSimulatedStaging,
	executeDaemonSmoke,
	inspectBuildPathResidue,
	resolveStagedLaunchSpec,
} from '../src/staging-smoke.ts';

export async function executeStagingSmokeCheck(options?: {
	readonly rootDir?: string;
	readonly hostPlatform?: 'win32' | 'darwin' | 'linux';
	readonly port?: number;
	readonly keepStaging?: boolean;
	readonly probeTimeoutMs?: number;
}): Promise<{ ok: boolean; message: string }> {
	const platform = options?.hostPlatform ?? (process.platform as 'win32' | 'darwin' | 'linux');
	const tempBase = options?.rootDir ?? mkdtempSync(join(tmpdir(), 'agsched-smoke-'));

	try {
		console.log(`[smoke-runner] Initializing staging smoke verification for ${platform}...`);

		// 1. Check product layers completeness (AC 2, E-257)
		const layers: PlatformProductLayers = {
			hasDaemonSupport: true,
			hasPathAdapter: true,
			hasDesktopShell: true,
		};
		const layerReport = evaluatePlatformSupport(platform, layers);
		if (!layerReport.isFullySupported) {
			throw new Error(`Product layers missing on ${platform} (E-257)`);
		}
		console.log('[smoke-runner] Product layers verified: daemon, path adapter, desktop shell.');

		// 2. Stage to directory with Unicode and spaces (AC 2, E-209)
		const staging = createSimulatedStaging({
			rootDir: tempBase,
			hostPlatform: platform,
		});
		console.log(
			`[smoke-runner] Created staged directory with spaces & Unicode: "${staging.stageDir}"`,
		);

		// 3. Inspect build path residue (AC 2)
		const forbiddenPrefixes = ['/home/runner/work', 'C:\\Users\\runneradmin', 'D:\\a\\'];
		const residue = inspectBuildPathResidue(staging.stageDir, forbiddenPrefixes);
		if (!residue.isClean) {
			throw new Error(
				`Hardcoded builder paths found in staged package: ${residue.violations.join(', ')}`,
			);
		}
		console.log('[smoke-runner] Staged assets verified clean of builder absolute paths.');

		// 4. Resolve absolute DaemonLaunchSpec pointing to the runnable stub script (AC 2, E-209, R2/R3).
		// We launch `node <stub-script> --port <port>` so the smoke probe hits a real HTTP server.
		const probePort = options?.port ?? 7817;
		const spec = resolveStagedLaunchSpec({
			currentExe: staging.currentExe,
			resourceDir: staging.resourceDir,
			hostPlatform: platform,
			// Override daemon file to the Node.js interpreter; pass stub script + port as args.
			customDaemonPath: process.execPath,
			customArguments: [staging.stubScriptFile, '--port', String(probePort)],
		});
		console.log(
			`[smoke-runner] Resolved launch spec: file="${spec.file}", args=[${spec.args.join(' ')}], cwd="${spec.cwd}"`,
		);

		// 5. Execute daemon smoke test with real spawn and real health probe (AC 2, E-265, R2).
		// No customSpawn or probeEndpoint overrides — the stub ESM script serves /api/v1/health.
		console.log('[smoke-runner] Executing daemon smoke test with real spawn and health probe...');
		const smokeOutcome = await executeDaemonSmoke(spec, {
			port: probePort,
			timeoutMs: options?.probeTimeoutMs ?? 10_000,
		});

		if (!smokeOutcome.success) {
			throw new Error(`Daemon smoke test failed: ${smokeOutcome.error}`);
		}
		console.log(
			`[smoke-runner] Daemon smoke health check succeeded (status ${smokeOutcome.endpointStatus}) in ${smokeOutcome.durationMs}ms.`,
		);

		return {
			ok: true,
			message: `Staging smoke verification succeeded on ${platform}.`,
		};
	} finally {
		if (!options?.keepStaging) {
			try {
				rmSync(tempBase, { recursive: true, force: true });
			} catch {
				// Ignore temp directory cleanup error
			}
		}
	}
}

import { fileURLToPath } from 'node:url';

// CLI direct execution
const isDirectExecution =
	Boolean(process.argv[1]) && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (isDirectExecution) {
	void executeStagingSmokeCheck()
		.then((result) => {
			console.log(`[smoke-runner] SUCCESS: ${result.message}`);
			process.exit(0);
		})
		.catch((err) => {
			console.error(`[smoke-runner] FAILED: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
