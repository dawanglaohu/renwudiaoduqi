import { spawnSync } from 'node:child_process';
import type { PrivateFileCommand } from '../platform/private-file-windows.ts';

export function runPrivateFileCommand(command: PrivateFileCommand): boolean {
	const result = spawnSync(command.file, [...command.args], {
		input: command.input,
		encoding: 'utf8',
		shell: false,
		windowsHide: true,
		timeout: 30_000,
		maxBuffer: 64 * 1024,
	});
	// Never propagate command diagnostics: the input contains the bootstrap secret.
	return !result.error && result.status === 0 && result.stdout === 'private-file-written';
}
