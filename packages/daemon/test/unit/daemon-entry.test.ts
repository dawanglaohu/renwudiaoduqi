import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const bootstrapPath = join(daemonRoot, 'bootstrap.mjs');
const temporaryDirectories: string[] = [];
const runningChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	for (const child of runningChildren.splice(0)) {
		await stopChild(child);
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe('daemon entry', () => {
	it('E-139 runs the JavaScript bootstrap under real Node 20 and exits cleanly', () => {
		const result = spawnSync(nodeExecutable(20), [bootstrapPath], {
			cwd: daemonRoot,
			encoding: 'utf8',
		});

		expect(result.status).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).toContain('requires Node.js >= 22');
		expect(result.stderr).toContain('current version is v20.19.5');
		expect(result.stderr).not.toContain('SyntaxError');
		expect(result.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
	});

	it('runs main under real Node 22, stays resident, and keeps the instance lock', async () => {
		const version = spawnSync(nodeExecutable(22), ['--version'], { encoding: 'utf8' });
		expect(version.status).toBe(0);
		expect(version.stdout.trim()).toBe('v22.17.0');

		const appDataDir = makeTemporaryDirectory();
		const environment = {
			...process.env,
			AGSCHED_PORT: '17817',
			APPDATA: appDataDir,
		};
		const first = startNode22(environment);
		const firstLog = await waitForStderr(first, 'boot self-check passed');
		const lockFilePath = join(appDataDir, 'agent-scheduler', 'daemon.lock');

		expect(first.exitCode).toBeNull();
		expect(firstLog).toContain(`pid=${first.pid}`);
		expect(firstLog).toContain('port=17817');

		const second = startNode22(environment);
		const secondResult = await waitForExit(second);
		expect(secondResult.code).toBe(1);
		expect(secondResult.stderr).toContain(`existing instance pid: ${first.pid}`);
		expect(secondResult.stderr).toContain(`lock file: ${lockFilePath}`);
		expect(first.exitCode).toBeNull();
	}, 120_000);

	it('exits non-zero when startup infrastructure fails', () => {
		const temporaryRoot = makeTemporaryDirectory();
		const invalidAppData = join(temporaryRoot, 'not-a-directory');
		writeFileSync(invalidAppData, 'occupied');
		const result = spawnSync(nodeExecutable(22), [bootstrapPath], {
			cwd: daemonRoot,
			encoding: 'utf8',
			env: { ...process.env, APPDATA: invalidAppData },
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('[startupFailure]');
	});
});

function startNode22(environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
	const child = spawn(nodeExecutable(22), [bootstrapPath], {
		cwd: daemonRoot,
		env: environment,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	runningChildren.push(child);
	return child;
}

function waitForStderr(child: ChildProcessWithoutNullStreams, expected: string): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		let stderr = '';
		const timer = setTimeout(() => {
			rejectPromise(new Error(`timed out waiting for stderr: ${stderr}`));
		}, 45_000);
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
			if (stderr.includes(expected)) {
				clearTimeout(timer);
				resolvePromise(stderr);
			}
		});
		child.once('exit', (code, signal) => {
			if (!stderr.includes(expected)) {
				clearTimeout(timer);
				rejectPromise(
					new Error(`daemon exited before readiness: code=${code} signal=${signal} ${stderr}`),
				);
			}
		});
	});
}

function waitForExit(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolvePromise, rejectPromise) => {
		let stderr = '';
		const timer = setTimeout(() => {
			rejectPromise(new Error(`timed out waiting for daemon exit: ${stderr}`));
		}, 45_000);
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			removeRunningChild(child);
			resolvePromise({ code, stderr });
		});
	});
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill();
	await new Promise<void>((resolvePromise) => {
		child.once('exit', () => resolvePromise());
	});
}

function removeRunningChild(child: ChildProcessWithoutNullStreams): void {
	const index = runningChildren.indexOf(child);
	if (index >= 0) runningChildren.splice(index, 1);
}

function nodeExecutable(major: 20 | 22): string {
	const platform =
		process.platform === 'win32'
			? 'win-x64'
			: process.platform === 'darwin'
				? 'darwin-x64'
				: 'linux-x64';
	const executable = process.platform === 'win32' ? 'node.exe' : 'node';
	return join(repositoryRoot, 'node_modules', `node${major}-${platform}`, 'bin', executable);
}

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'agent-scheduler-entry-'));
	temporaryDirectories.push(directory);
	return directory;
}
