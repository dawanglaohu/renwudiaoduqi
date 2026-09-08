import { spawnSync } from 'node:child_process';
import type { NativeLockCommand } from '../platform/lock-contract.ts';

export interface LockCommandResult {
	readonly ok: boolean;
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export function runLockCommand(command: NativeLockCommand): LockCommandResult {
	const result = spawnSync(command.file, [...command.args], {
		encoding: 'utf8',
		shell: false,
		windowsHide: true,
	});
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	if (result.error !== undefined) {
		return {
			ok: false,
			status: result.status,
			stdout,
			stderr: stderr.length > 0 ? stderr : result.error.message,
		};
	}
	return {
		ok: result.status === 0,
		status: result.status,
		stdout,
		stderr,
	};
}
