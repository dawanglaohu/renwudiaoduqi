import type { ProcessConfig } from '../config/env.ts';
import type { AppContainer } from '../boot/container.ts';
import { checkNodeVersion } from '../boot/node-check.ts';

export interface BootFailure {
	readonly stage: 'node-version' | 'env' | 'data-dir' | 'lock';
	readonly exitCode: number;
	readonly lines: string[];
}

export type BootResult =
	| { readonly ok: true; readonly config: ProcessConfig }
	| { readonly ok: false; readonly failure: BootFailure };

export function runBootSelfCheck(container: AppContainer): BootResult {
	const nodeResult = checkNodeVersion(container.nodeVersion);
	if (!nodeResult.ok) {
		return fail('node-version', [
			nodeResult.message,
			`Required: Node.js >= ${nodeResult.requiredMajor}.0.0`,
			`Current : ${nodeResult.currentVersion}`,
		]);
	}

	const configResult = container.parseProcessConfig();
	if (!configResult.ok) {
		return fail('env', [
			`${configResult.variable} has invalid format: "${configResult.actual}". Expected ${configResult.expected}.`,
			'Fix the environment variable and restart the daemon.',
		]);
	}

	return { ok: true, config: configResult.config };
}

function fail(stage: BootFailure['stage'], lines: string[]): BootResult {
	return { ok: false, failure: { exitCode: 1, stage, lines } };
}
