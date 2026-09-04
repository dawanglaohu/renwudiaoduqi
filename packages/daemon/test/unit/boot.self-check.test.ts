import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, readPidFromLock } from '../../src/boot/lock.ts';
import { checkNodeVersion } from '../../src/boot/node-check.ts';
import { defaultDataDir, resolveLockFilePath } from '../../src/boot/paths.ts';
import { parseProcessConfig } from '../../src/config/env.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe('boot self-check', () => {
	it('E-139 rejects Node 20 with the required version', () => {
		expect(checkNodeVersion('v20.19.5')).toEqual({
			ok: false,
			currentVersion: 'v20.19.5',
			requiredMajor: 22,
			message:
				'agent-scheduler daemon requires Node.js >= 22.0.0, current version is v20.19.5. Upgrade Node.js and start again.',
		});
	});

	it('E-139 accepts Node 22', () => {
		expect(checkNodeVersion('v22.17.0')).toEqual({ ok: true });
	});

	it('uses the default port only when AGSCHED_PORT is absent or empty', () => {
		expect(parseProcessConfig({ port: undefined })).toEqual({
			ok: true,
			config: { port: 7817 },
		});
		expect(parseProcessConfig({ port: '' })).toEqual({
			ok: true,
			config: { port: 7817 },
		});
	});

	it.each(['abc', '0', '70000'])('rejects AGSCHED_PORT=%s', (port) => {
		expect(parseProcessConfig({ port })).toEqual({
			ok: false,
			variable: 'AGSCHED_PORT',
			expected: 'an integer port in 1..65535',
			actual: port,
		});
	});

	it('resolves data paths only from injected host inputs', () => {
		const root = makeTemporaryDirectory();
		expect(defaultDataDir({ appDataDir: root, homeDir: 'unused' })).toBe(
			join(root, 'agent-scheduler'),
		);
		expect(defaultDataDir({ appDataDir: undefined, homeDir: root })).toBe(
			join(root, '.agent-scheduler'),
		);
		expect(resolveLockFilePath({ appDataDir: root, homeDir: 'unused' })).toBe(
			join(root, 'agent-scheduler', 'daemon.lock'),
		);
	});

	it('E-03 keeps the first pid visible and permits reacquisition after release', () => {
		const lockFilePath = join(makeTemporaryDirectory(), 'daemon.lock');
		const first = acquireInstanceLock(lockFilePath, 4321);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(readPidFromLock(lockFilePath)).toBe(4321);

		expect(acquireInstanceLock(lockFilePath, 9876)).toEqual({
			ok: false,
			lockFilePath,
			existingPid: 4321,
		});

		first.lock.release();
		first.lock.release();
		const reacquired = acquireInstanceLock(lockFilePath, 9876);
		expect(reacquired.ok).toBe(true);
		if (reacquired.ok) reacquired.lock.release();
	});
});

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'agent-scheduler-'));
	temporaryDirectories.push(directory);
	return directory;
}
