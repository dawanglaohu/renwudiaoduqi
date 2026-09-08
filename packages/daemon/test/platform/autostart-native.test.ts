import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
	AutostartDependencies,
	CommandResult,
} from '../../src/platform/autostart-contract.ts';
import { createPlatformAdapter } from '../../src/platform/host.ts';

const TEST_NAME = `agent-scheduler-test-${process.pid}-${randomUUID()}`;
const SPEC = Object.freeze({
	file: process.execPath,
	args: Object.freeze(['-e', 'process.exit(0)']),
	cwd: process.cwd(),
});

const dependencies: AutostartDependencies = {
	files: {
		makeDirectory: (path) => mkdir(path, { recursive: true }).then(() => undefined),
		readTextFile: (path) => readFile(path, 'utf8'),
		writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
		removeFile: (path) => rm(path, { force: false }),
	},
	runCommand,
	temporaryDirectory: join(tmpdir(), 'agent-scheduler-autostart-tests'),
};

describe('native autostart integration (E-269)', () => {
	it('uses an isolated name and leaves no native registration', async () => {
		const result = createPlatformAdapter(
			process.platform,
			{ homedir: homedir() },
			TEST_NAME,
			dependencies,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { autostart } = result.value;
		let cleanupFailure: string | undefined;
		let didRegister = false;
		try {
			const registered = await autostart.register(SPEC);
			didRegister = registered.ok;
			if (!registered.ok) {
				expect(['E_AUTOSTART_UNSUPPORTED', 'E_AUTOSTART_REGISTER_DENIED']).toContain(
					registered.error.code,
				);
			} else {
				const status = await autostart.status(SPEC);
				expect(status.ok && status.value.matchesSpec).toBe(true);
			}
		} finally {
			const cleanup = await autostart.unregister();
			const residual = await autostart.status(SPEC);
			const hasResidual = residual.ok && residual.value.registered;
			if (
				(didRegister && (!cleanup.ok || !residual.ok || hasResidual)) ||
				(!didRegister && hasResidual)
			) {
				cleanupFailure = `autostart cleanup failed for ${TEST_NAME}; remove it manually with:\n${autostart.manualUnregisterCommand}`;
			}
		}
		if (cleanupFailure !== undefined) throw new Error(cleanupFailure);
	});
});

function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
	return new Promise((resolve) => {
		execFile(file, [...args], { windowsHide: true }, (cause, stdout, stderr) => {
			if (cause === null) {
				resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
				return;
			}
			const nativeCode = typeof cause.code === 'number' ? cause.code : null;
			const isMissingQuery =
				(file === 'schtasks.exe' && (args.includes('/Query') || args.includes('/Delete'))) ||
				(file === 'launchctl' && (args.includes('list') || args.includes('unload'))) ||
				(file === 'systemctl' && (args.includes('is-enabled') || args.includes('disable')));
			const kind =
				cause.code === 'ENOENT'
					? 'unsupported'
					: isMissingQuery
						? 'not-found'
						: file === 'systemctl'
							? 'unsupported'
							: 'denied';
			resolve({
				ok: false,
				kind,
				code: nativeCode,
				stdout: String(stdout),
				stderr: String(stderr),
				cause,
			});
		});
	});
}
