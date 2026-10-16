import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
	KillTreeAttemptResult,
	KillTreeProcessOps,
} from '../../src/platform/kill-tree-contract.ts';
import { posixKillTree } from '../../src/platform/kill-tree-posix.ts';
import { windowsKillTree } from '../../src/platform/windows.ts';

describe('native process-tree integration (E-119)', () => {
	it.skipIf(process.platform !== 'win32')(
		'M1-T12 R3: a managed Windows process outlives its daemon parent for real PID reconciliation',
		async () => {
			const workingRoot = await mkdtemp(join(tmpdir(), 'm1-t12-parent-exit-'));
			expect(dirname(resolve(workingRoot))).toBe(resolve(tmpdir()));
			const pidPath = join(workingRoot, 'managed.pid');
			const daemonRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
			const parentScript = [
				"import { register } from 'node:module';",
				"import { writeFileSync } from 'node:fs';",
				`register(${JSON.stringify(pathToFileURL(join(daemonRoot, 'typescript-loader.mjs')).href)});`,
				`const { spawnManaged } = await import(${JSON.stringify(pathToFileURL(join(daemonRoot, 'src/proc/spawn.ts')).href)});`,
				`const managed = spawnManaged({ runId: 'm1-t12-parent-exit', file: process.execPath, args: ['-e', "console.log('READY'); setInterval(() => {}, 1000)"], cwd: ${JSON.stringify(workingRoot)} }, { platform: 'win32' });`,
				`writeFileSync(${JSON.stringify(pidPath)}, String(managed.pid));`,
				"managed.onLine((line) => { if (line.text === 'READY') process.exit(0); });",
				'setTimeout(() => process.exit(2), 10000);',
			].join('\n');
			const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], {
				windowsHide: true,
				stdio: 'pipe',
			});
			const parentExited = waitForChildExit(parent);
			let stderr = '';
			parent.stderr?.on('data', (chunk) => {
				stderr += String(chunk);
			});
			let pid: number | undefined;
			try {
				pid = await readPid(pidPath, 15000);
				expect(await parentExited, stderr).toBe(true);
				expect(parent.exitCode, stderr).toBe(0);
				await new Promise((done) => setTimeout(done, 250));
				expect(await probePidExited(pid)).toBe(false);
			} finally {
				if (parent.pid && parent.exitCode === null)
					await runTaskkill(['/PID', String(parent.pid), '/T', '/F']);
				if (pid !== undefined) {
					await runTaskkill(['/PID', String(pid), '/T', '/F']);
					expect(await waitUntilExited(pid)).toBe(true);
				}
				await rm(workingRoot, { recursive: true, force: true });
			}
		},
		30000,
	);

	it('terminates an isolated native process group through the host policy', async () => {
		const workingRoot = await mkdtemp(join(tmpdir(), 'm1-t9-kill-tree-'));
		const descendantPidPath = join(workingRoot, 'descendant.pid');
		const parentScript = [
			"const { spawn } = require('node:child_process');",
			"const { writeFileSync } = require('node:fs');",
			'const script = \'process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)\';',
			"const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });",
			'writeFileSync(process.argv[1], String(child.pid));',
			"if (process.platform !== 'win32') process.on('SIGTERM', () => {});",
			'setInterval(() => {}, 1000);',
		].join(' ');
		const parent = spawn(process.execPath, ['-e', parentScript, descendantPidPath], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		});
		const pid = parent.pid;
		expect(pid).toBeTypeOf('number');
		if (pid === undefined) {
			await rm(workingRoot, { recursive: true, force: true });
			return;
		}
		const parentExited = waitForChildExit(parent);
		let descendantPid: number | undefined;
		const processOps = nativeProcessOps();
		let cleanupCause: unknown;
		try {
			descendantPid = await readPid(descendantPidPath);
			const result =
				process.platform === 'win32'
					? await windowsKillTree(pid, processOps, { graceMs: 50 })
					: await posixKillTree(pid, processOps, { graceMs: 50 });
			expect(result.outcome).toBe('terminated');
			expect(result.attempts[0]?.method).toBe(
				process.platform === 'win32' ? 'taskkill-soft' : 'sigterm',
			);
			if (process.platform !== 'win32') {
				expect(result.attempts.map((attempt) => attempt.method)).toEqual(['sigterm', 'sigkill']);
			}
			expect(await parentExited).toBe(true);
			expect(await waitUntilExited(descendantPid)).toBe(true);
		} finally {
			if (process.platform === 'win32') {
				await runTaskkill(['/PID', String(pid), '/T', '/F']);
				if (descendantPid !== undefined) {
					await runTaskkill(['/PID', String(descendantPid), '/T', '/F']);
				}
			} else {
				try {
					process.kill(-pid, 'SIGKILL');
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') cleanupCause = cause;
				}
				if (descendantPid !== undefined) {
					try {
						process.kill(descendantPid, 'SIGKILL');
					} catch (cause) {
						if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') cleanupCause ??= cause;
					}
				}
			}
			await rm(workingRoot, { recursive: true, force: true });
		}
		if (cleanupCause !== undefined) throw cleanupCause;
	}, 30_000);
});

function nativeProcessOps(): KillTreeProcessOps {
	return {
		now: () => new Date().toISOString(),
		wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		taskkill: runTaskkill,
		signalGroup: (pid, signal) => signalGroup(pid, signal),
		probeTree: async (pid) => probeProcess(pid),
		probeGroup: (pid) => probeGroup(pid),
	};
}

function signalGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): KillTreeAttemptResult {
	try {
		process.kill(-pid, signal);
		return signal === 'SIGKILL' ? 'terminated' : 'still-running';
	} catch (cause) {
		return classifyNativeFailure(cause);
	}
}

async function readPid(path: string, timeoutMs = 5000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('The descendant process did not publish its PID.');
}

async function waitUntilExited(pid: number): Promise<boolean> {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		if (await probePidExited(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

function waitForChildExit(child: ChildProcess): Promise<boolean> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(false), 15000);
		child.once('exit', () => {
			clearTimeout(timeout);
			resolve(true);
		});
	});
}

async function probePidExited(pid: number): Promise<boolean> {
	if (process.platform === 'win32') {
		return new Promise((resolve) => {
			execFile(
				'tasklist.exe',
				['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
				{ windowsHide: true },
				(cause, stdout) => {
					const listedPids = String(stdout)
						.split(/\r?\n/)
						.map((line) => line.match(/^"[^"]*","(\d+)"/)?.[1])
						.filter((value): value is string => value !== undefined);
					resolve(cause !== null || !listedPids.includes(String(pid)));
				},
			);
		});
	}
	return new Promise((resolve) => {
		execFile('ps', ['-p', String(pid), '-o', 'stat='], (cause, stdout) => {
			const state = String(stdout).trim();
			resolve(cause !== null || state.length === 0 || state.startsWith('Z'));
		});
	});
}

function probeGroup(pid: number): KillTreeAttemptResult {
	try {
		process.kill(-pid, 0);
		return 'still-running';
	} catch (cause) {
		return classifyNativeFailure(cause);
	}
}

function probeProcess(pid: number): KillTreeAttemptResult {
	try {
		process.kill(pid, 0);
		return 'still-running';
	} catch (cause) {
		return classifyNativeFailure(cause);
	}
}

function classifyNativeFailure(cause: unknown): KillTreeAttemptResult {
	const code = (cause as NodeJS.ErrnoException).code;
	if (code === 'ESRCH') return 'terminated';
	if (code === 'EPERM') return 'not-process-owner';
	return 'still-running';
}

function runTaskkill(args: readonly string[]): Promise<KillTreeAttemptResult> {
	return new Promise((resolve) => {
		execFile('taskkill.exe', [...args], { windowsHide: true }, (cause, _stdout, stderr) => {
			if (cause === null) resolve(args.includes('/F') ? 'terminated' : 'still-running');
			else if (typeof cause.code === 'number' && cause.code === 128) {
				resolve(/not found/i.test(String(stderr)) ? 'terminated' : 'still-running');
			} else resolve('still-running');
		});
	});
}
