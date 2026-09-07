import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformHostInputs } from '../../src/platform/contract.ts';
import { LINUX_AUTOSTART, linuxAutostartDeleteLine } from '../../src/platform/linux.ts';

const TEST_NAME = `agent-scheduler-test-${process.pid}-${Date.now().toString(36)}`;

function hostInputs(): PlatformHostInputs {
	return Object.freeze({
		platform: 'linux',
		homedir: '/home/tester',
		appData: undefined,
		xdgDataHome: undefined,
	});
}

function daemonSpec(workingRoot: string) {
	return Object.freeze({
		file: '/usr/bin/node',
		args: Object.freeze(['/opt/agent-scheduler/daemon/src/main.ts']),
		cwd: workingRoot,
	});
}

async function isSystemdUserAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile('systemctl', ['--user', 'is-system-running'], (cause) => {
			resolve(cause === null || cause.code === 0);
		});
	});
}

describe.skipIf(process.platform !== 'linux')('linux autostart integration (E-269)', () => {
	let workingRoot = '';
	let systemdUserAvailable = false;

	beforeAll(async () => {
		workingRoot = mkdtempSync(join(tmpdir(), 'm1t9-linux-autostart-'));
		systemdUserAvailable = await isSystemdUserAvailable();
	});

	afterAll(async () => {
		if (systemdUserAvailable) {
			// Best-effort cleanup with the same isolation name; a failure here must
			// fail the suite and print the manual removal command (E-269, E-210).
			const outcome = await LINUX_AUTOSTART.unregister(TEST_NAME, hostInputs()).catch((cause) => ({
				ok: false as const,
				cause,
			}));
			if ('ok' in outcome && outcome.ok === false) {
				throw new Error(
					`autostart cleanup failed for ${TEST_NAME}; remove it manually with:\n${linuxAutostartDeleteLine(TEST_NAME, hostInputs())}`,
				);
			}
		}
		rmSync(workingRoot, { recursive: true, force: true });
	});

	it('register→status→re-register idempotent→spec rewrite→unregister', async () => {
		const spec = daemonSpec(workingRoot);
		const first = await LINUX_AUTOSTART.register(TEST_NAME, spec, hostInputs());

		if (!systemdUserAvailable) {
			// E-261: no user systemd instance must surface as a typed failure and
			// never silently leave a unit file behind.
			expect(first.ok).toBe(false);
			if (!first.ok) {
				expect(['E_AUTOSTART_UNSUPPORTED', 'E_AUTOSTART_REGISTER_DENIED']).toContain(
					first.error.code,
				);
			}
			return;
		}
		expect(first.ok).toBe(true);

		const registered = await LINUX_AUTOSTART.status(TEST_NAME, spec, hostInputs());
		expect(registered.ok).toBe(true);
		if (!registered.ok) return;
		expect(registered.value.registered).toBe(true);
		expect(registered.value.matchesSpec).toBe(true);

		// Idempotent re-register with the same frozen spec must be a no-op.
		const second = await LINUX_AUTOSTART.register(TEST_NAME, spec, hostInputs());
		expect(second.ok).toBe(true);

		// E-209: a field-level spec change must rewrite the native entry.
		const movedSpec = daemonSpec(`${workingRoot}-moved`);
		const rewritten = await LINUX_AUTOSTART.register(TEST_NAME, movedSpec, hostInputs());
		expect(rewritten.ok).toBe(true);
		const afterRewrite = await LINUX_AUTOSTART.status(TEST_NAME, movedSpec, hostInputs());
		expect(afterRewrite.ok && afterRewrite.value.matchesSpec).toBe(true);

		const dropped = await LINUX_AUTOSTART.unregister(TEST_NAME, hostInputs());
		expect(dropped.ok).toBe(true);
	});
});
