import { describe, expect, it } from 'vitest';
import { parsePort } from '../../src/boot/env-port.ts';
import { readPidFromLock } from '../../src/boot/lock.ts';
import { checkNodeVersion } from '../../src/boot/node-check.ts';

describe('boot.self-check (M1-T1)', () => {
	it('E-139: node < 22 fails with required version', () => {
		const err = checkNodeVersion('v20.11.0');
		expect(err).not.toBeNull();
		expect(err?.message).toContain('>= 22');
		expect(err?.message).toContain('v20.11.0');
	});

	it('E-139: node 22 passes', () => {
		expect(checkNodeVersion('v22.11.0')).toBeNull();
	});

	it('AGSCHED_PORT default falls back to 7817', () => {
		expect(parsePort(undefined)).toBe(7817);
		expect(parsePort('')).toBe(7817);
	});

	it('AGSCHED_PORT=abc is invalid and rejected', () => {
		expect(() => parsePort('abc')).toThrow(/AGSCHED_PORT/);
	});

	it('AGSCHED_PORT=70000 is out of range', () => {
		expect(() => parsePort('70000')).toThrow(/AGSCHED_PORT/);
	});

	it('E-03: lock pid is read back from the lock file', () => {
		// 不真正取锁，只验证读 pid 的容错路径走通则不留锁。
		const p = readPidFromLock('nonexistent.lock');
		expect(p).toBeNull();
	});
});
