import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const bootstrapPath = join(daemonRoot, 'bootstrap.mjs');

describe('daemon entry', () => {
	it('E-139 rejects real Node 20 before TypeScript loading', () => {
		const result = spawnSync(nodeExecutable(20), [bootstrapPath], {
			cwd: daemonRoot,
			encoding: 'utf8',
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('requires Node.js >= 22');
		expect(result.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
	});

	it('loads the real Node 22 entry and rejects invalid process config before locking', () => {
		const result = spawnSync(process.execPath, [bootstrapPath], {
			cwd: daemonRoot,
			encoding: 'utf8',
			env: { ...process.env, AGSCHED_PORT: 'abc' },
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('[startupFailure]');
		expect(result.stderr).toContain('AGSCHED_PORT');
		expect(result.stderr).toContain('1..65535');
	});
});

function nodeExecutable(major: 20): string {
	const platform =
		process.platform === 'win32'
			? 'win-x64'
			: process.platform === 'darwin'
				? 'darwin-x64'
				: 'linux-x64';
	const executable = process.platform === 'win32' ? 'node.exe' : 'node';
	return join(repositoryRoot, 'node_modules', `node${major}-${platform}`, 'bin', executable);
}
