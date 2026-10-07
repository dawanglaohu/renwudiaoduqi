import { describe, expect, it, vi } from 'vitest';
import { runPrivateFileCommand } from '../../src/proc/private-file-command.ts';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync }));

const command = {
	file: 'powershell.exe',
	args: ['-EncodedCommand', 'static-script'],
	input: 'secret',
};

describe('private file command runner', () => {
	it('sends secret input through the pipe and requires the success marker', () => {
		spawnSync.mockReturnValue({ status: 0, stdout: 'private-file-written', stderr: '' });
		expect(runPrivateFileCommand(command)).toBe(true);
		expect(spawnSync).toHaveBeenCalledWith(command.file, command.args, {
			input: 'secret',
			encoding: 'utf8',
			shell: false,
			windowsHide: true,
			timeout: 30_000,
			maxBuffer: 64 * 1024,
		});
	});

	it.each([
		{ status: 1, stdout: 'secret', stderr: 'secret' },
		{ status: 0, stdout: 'unexpected', stderr: '' },
		{ status: null, stdout: '', stderr: 'secret', error: new Error('secret') },
	])('fails without returning subprocess diagnostics', (result) => {
		spawnSync.mockReturnValue(result);
		expect(runPrivateFileCommand(command)).toBe(false);
	});
});
