import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutostartAdapter } from '@agent-scheduler/daemon/platform/autostart-contract';
import { describe, expect, it, vi } from 'vitest';
import * as autostartHandlerModule from '../src/autostart-handler.ts';
import {
	type AutostartPromptDecision,
	FileAutostartPreferenceStore,
	MemoryAutostartPreferenceStore,
	syncDesktopAutostart,
} from '../src/autostart-handler.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';

describe('desktop autostart-handler (AC 4, AC 5, E-208, E-209, E-210)', () => {
	const testSpec = resolveLaunchSpec({
		currentExe: '/opt/scheduler/bin/scheduler',
		resourceDir: '/opt/scheduler/lib',
		hostPlatform: 'linux',
	});

	function createFakeAdapter(overrides?: Partial<AutostartAdapter>): AutostartAdapter {
		return {
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { registered: false, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({ ok: true, value: null }),
			unregister: vi.fn().mockResolvedValue({ ok: true, value: null }),
			manualStartCommand: vi.fn().mockReturnValue('systemctl --user start daemon'),
			manualUnregisterCommand: 'systemctl --user stop daemon',
			...overrides,
		};
	}

	it('registers on first run and sets previously configured flag (AC 4, R6)', async () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter = createFakeAdapter();

		const result = await syncDesktopAutostart({
			adapter: mockAdapter,
			spec: testSpec,
			store,
		});

		expect(result.outcome).toBe('registered');
		expect(result.registered).toBe(true);
		expect(mockAdapter.register).toHaveBeenCalledWith(testSpec);
		expect(store.getWasPreviouslyConfigured()).toBe(true);
	});

	it('leaves registration unchanged when spec paths match (E-209)', async () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter = createFakeAdapter({
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { registered: true, matchesSpec: true },
			}),
			register: vi.fn(),
		});

		const result = await syncDesktopAutostart({
			adapter: mockAdapter,
			spec: testSpec,
			store,
		});

		expect(result.outcome).toBe('unchanged');
		expect(result.registered).toBe(true);
		expect(mockAdapter.register).not.toHaveBeenCalled();
	});

	it('rewrites registration when spec paths mismatch (upgrade/relocation) (E-209, R6)', async () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter = createFakeAdapter({
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { registered: true, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({ ok: true, value: null }),
		});

		const result = await syncDesktopAutostart({
			adapter: mockAdapter,
			spec: testSpec,
			store,
		});

		expect(result.outcome).toBe('rewritten');
		expect(result.registered).toBe(true);
		expect(mockAdapter.register).toHaveBeenCalledWith(testSpec);
	});

	it('degrades non-fatally to manual command when registration denied (E-210, R6)', async () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter = createFakeAdapter({
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { registered: false, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({
				ok: false,
				error: {
					code: 'E_AUTOSTART_REGISTER_DENIED',
					message: 'Permission denied',
					details: { manualStartCommand: 'systemctl --user start daemon' },
				},
			}),
		});

		const result = await syncDesktopAutostart({
			adapter: mockAdapter,
			spec: testSpec,
			store,
		});

		expect(result.outcome).toBe('failed');
		expect(result.registered).toBe(false);
		if (result.outcome === 'failed') {
			expect(result.manualCommand).toBe('systemctl --user start daemon');
		}
	});

	it('asserts that shell does not implement a second field-by-field spec comparison (R6)', () => {
		expect((autostartHandlerModule as Record<string, unknown>).specsEqual).toBeUndefined();
		expect((autostartHandlerModule as Record<string, unknown>).areSpecsIdentical).toBeUndefined();
	});

	describe('User externally disabled autostart (AC 5, E-208, R7)', () => {
		it('dismisses without re-registering when previously configured and no promptUser provided (R7, E-208)', async () => {
			const store = new MemoryAutostartPreferenceStore();
			store.setWasPreviouslyConfigured(true);

			const mockAdapter = createFakeAdapter({
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { registered: false, matchesSpec: false },
				}),
				register: vi.fn(),
			});

			const result = await syncDesktopAutostart({
				adapter: mockAdapter,
				spec: testSpec,
				store,
				promptUser: undefined,
			});

			// Must be dismissed, NEVER silently registered!
			expect(result.outcome).toBe('dismissed');
			expect(result.registered).toBe(false);
			expect(mockAdapter.register).not.toHaveBeenCalled();
		});

		it('detects external disablement and prompts user, re-registering if accepted', async () => {
			const store = new MemoryAutostartPreferenceStore();
			store.setWasPreviouslyConfigured(true);

			const mockAdapter = createFakeAdapter({
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { registered: false, matchesSpec: false },
				}),
			});

			const promptMock = vi.fn().mockResolvedValue('re_register' as AutostartPromptDecision);

			const result = await syncDesktopAutostart({
				adapter: mockAdapter,
				spec: testSpec,
				store,
				promptUser: promptMock,
			});

			expect(result.outcome).toBe('re_registered');
			expect(result.registered).toBe(true);
			expect(promptMock).toHaveBeenCalled();
			expect(mockAdapter.register).toHaveBeenCalledWith(testSpec);
		});

		it('detects external disablement and does not re-register if user dismisses', async () => {
			const store = new MemoryAutostartPreferenceStore();
			store.setWasPreviouslyConfigured(true);

			const mockAdapter = createFakeAdapter({
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { registered: false, matchesSpec: false },
				}),
				register: vi.fn(),
			});

			const promptMock = vi.fn().mockResolvedValue('dismiss' as AutostartPromptDecision);

			const result = await syncDesktopAutostart({
				adapter: mockAdapter,
				spec: testSpec,
				store,
				promptUser: promptMock,
			});

			expect(result.outcome).toBe('dismissed');
			expect(result.registered).toBe(false);
			expect(mockAdapter.register).not.toHaveBeenCalled();
		});

		it('honors "never_ask" decision: sets suppression and does not prompt again', async () => {
			const store = new MemoryAutostartPreferenceStore();
			store.setWasPreviouslyConfigured(true);

			const mockAdapter = createFakeAdapter({
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { registered: false, matchesSpec: false },
				}),
				register: vi.fn(),
			});

			const promptMock = vi.fn().mockResolvedValue('never_ask' as AutostartPromptDecision);

			const firstResult = await syncDesktopAutostart({
				adapter: mockAdapter,
				spec: testSpec,
				store,
				promptUser: promptMock,
			});

			expect(firstResult.outcome).toBe('disabled_silenced');
			expect(store.getNeverAskAgain()).toBe(true);
			expect(mockAdapter.register).not.toHaveBeenCalled();

			promptMock.mockClear();
			const secondResult = await syncDesktopAutostart({
				adapter: mockAdapter,
				spec: testSpec,
				store,
				promptUser: promptMock,
			});

			expect(secondResult.outcome).toBe('disabled_silenced');
			expect(promptMock).not.toHaveBeenCalled();
			expect(mockAdapter.register).not.toHaveBeenCalled();
		});

		it('persists preferences to disk across instances using FileAutostartPreferenceStore (R7)', () => {
			const tempFile = join(
				tmpdir(),
				`agsched-test-pref-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
			);
			try {
				const store1 = new FileAutostartPreferenceStore(tempFile);
				expect(store1.getWasPreviouslyConfigured()).toBe(false);
				expect(store1.getNeverAskAgain()).toBe(false);

				store1.setWasPreviouslyConfigured(true);
				store1.setNeverAskAgain(true);

				// Second store reading from same disk path
				const store2 = new FileAutostartPreferenceStore(tempFile);
				expect(store2.getWasPreviouslyConfigured()).toBe(true);
				expect(store2.getNeverAskAgain()).toBe(true);
			} finally {
				if (existsSync(tempFile)) {
					rmSync(tempFile, { force: true });
				}
			}
		});
	});
});
