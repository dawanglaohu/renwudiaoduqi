import { describe, expect, it } from 'vitest';
import { serializeLockMetadata } from '../../src/platform/lock-contract.ts';
import { verifyWindowsAclOutput } from '../../src/platform/lock-windows.ts';
import {
	LINUX_LOCK_DIR,
	MACOS_LOCK_DIR,
	WINDOWS_LOCK_DIR_FALLBACK,
	lockDirPath,
	lockFilePath,
	requiredLockPermissionLines,
} from '../../src/platform/lock.ts';

describe('platform lock paths', () => {
	it('exposes the three machine-wide lock file paths of acceptance criterion 1', () => {
		expect(lockFilePath('win32', {})).toBe('C:\\ProgramData\\agent-scheduler\\daemon.lock');
		expect(lockFilePath('win32', { programData: 'D:\\SystemData' })).toBe(
			'D:\\SystemData\\agent-scheduler\\daemon.lock',
		);
		expect(lockFilePath('darwin', {})).toBe(
			'/Library/Application Support/agent-scheduler/daemon.lock',
		);
		expect(lockFilePath('linux', {})).toBe('/var/lib/agent-scheduler/daemon.lock');
	});

	it('keeps lock directory constants machine-wide, not per-user', () => {
		expect(WINDOWS_LOCK_DIR_FALLBACK).toBe('C:\\ProgramData\\agent-scheduler');
		expect(MACOS_LOCK_DIR).toBe('/Library/Application Support/agent-scheduler');
		expect(LINUX_LOCK_DIR).toBe('/var/lib/agent-scheduler');
	});

	it('prints the required permission commands for each platform on insufficient rights', () => {
		const dir = lockDirPath('linux', {});
		const lines = requiredLockPermissionLines('linux', dir, `${dir}/daemon.lock`);
		expect(lines.some((line) => line.includes('chmod 0600'))).toBe(true);
		expect(lines.some((line) => line.includes('root:root'))).toBe(true);

		const darwinLines = requiredLockPermissionLines(
			'darwin',
			MACOS_LOCK_DIR,
			`${MACOS_LOCK_DIR}/daemon.lock`,
		);
		expect(darwinLines.some((line) => line.includes('root:admin'))).toBe(true);

		const winLines = requiredLockPermissionLines(
			'win32',
			WINDOWS_LOCK_DIR_FALLBACK,
			`${WINDOWS_LOCK_DIR_FALLBACK.replaceAll('\\', '\\\\')}\\\\daemon.lock`,
		);
		expect(
			winLines.some((line) => line.includes('Administrators') && line.includes('SYSTEM')),
		).toBe(true);
	});

	it('serializes exactly the five machine-lock metadata fields', () => {
		expect(
			JSON.parse(
				serializeLockMetadata({
					pid: 123,
					uid: '1000',
					startedAt: '2026-09-07T01:02:03.004Z',
					port: 7817,
					bind: '0.0.0.0',
				}),
			),
		).toEqual({
			pid: 123,
			uid: '1000',
			startedAt: '2026-09-07T01:02:03.004Z',
			port: 7817,
			bind: '0.0.0.0',
		});
	});

	it('accepts only Administrators and SYSTEM full-control Windows ACL entries', () => {
		const safe = [
			'C:\\ProgramData\\agent-scheduler BUILTIN\\Administrators:(F)',
			'                                    NT AUTHORITY\\SYSTEM:(F)',
		].join('\r\n');
		const unsafe = `${safe}\r\n                                    BUILTIN\\Users:(RX)`;
		expect(verifyWindowsAclOutput(safe)).toBe(true);
		expect(verifyWindowsAclOutput(unsafe)).toBe(false);
	});
});
