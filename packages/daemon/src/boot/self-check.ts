import type { ProcessConfig } from '../config/env.ts';
import type { AppContainer } from './container.ts';
import type { LockHandle } from './lock.ts';
import { checkNodeVersion } from './node-check.ts';

export interface BootFailure {
	readonly stage: 'node-version' | 'env' | 'single-instance';
	readonly exitCode: number;
	readonly lines: string[];
}

export type BootResult =
	| { readonly ok: true; readonly config: ProcessConfig; readonly lock: LockHandle }
	| { readonly ok: false; readonly failure: BootFailure };

export function runBootSelfCheck(container: AppContainer): BootResult {
	const versionResult = checkNodeVersion(container.nodeVersion);
	if (!versionResult.ok) {
		return fail('node-version', [
			versionResult.message,
			`Required: Node.js >= ${versionResult.requiredMajor}.0.0`,
			`Current : ${versionResult.currentVersion}`,
		]);
	}

	const configResult = container.parseProcessConfig();
	if (!configResult.ok) {
		return fail('env', [
			`${configResult.variable} has invalid format: "${configResult.actual}". Expected ${configResult.expected}.`,
			'Fix the environment variable and restart the daemon. Default is not applied here.',
		]);
	}

	const lockResult = container.acquireInstanceLock();
	if (!lockResult.ok) {
		const pidPart =
			lockResult.existingPid === null
				? 'existing instance pid: unknown (lock file has no readable pid)'
				: `existing instance pid: ${lockResult.existingPid}`;
		return fail('single-instance', [
			`another daemon instance already holds the lock at "${lockResult.lockFilePath}".`,
			`lock file: ${lockResult.lockFilePath}`,
			pidPart,
			'This daemon refuses to start; hand the request to the already-running instance.',
		]);
	}

	return { ok: true, config: configResult.config, lock: lockResult.lock };
}

function fail(stage: BootFailure['stage'], lines: string[]): BootResult {
	return { ok: false, failure: { exitCode: 1, stage, lines } };
}
