import { describe, expect, it, vi } from 'vitest';
import {
	type AutostartAdapterBridge,
	type AutostartPromptDecision,
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

	it('registers on first run and sets previously configured flag (AC 4)', () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter: AutostartAdapterBridge = {
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { supported: true, registered: false, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({ ok: true }),
			manualStartCommand: vi.fn().mockReturnValue('systemctl --user start daemon'),
		};

		return syncDesktopAutostart({ adapter: mockAdapter, spec: testSpec, store }).then((result) => {
			expect(result.outcome).toBe('registered');
			expect(result.registered).toBe(true);
			expect(mockAdapter.register).toHaveBeenCalledWith(testSpec);
			expect(store.getWasPreviouslyConfigured()).toBe(true);
		});
	});

	it('leaves registration unchanged when spec paths match (E-209)', () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter: AutostartAdapterBridge = {
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { supported: true, registered: true, matchesSpec: true },
			}),
			register: vi.fn(),
			manualStartCommand: vi.fn().mockReturnValue(''),
		};

		return syncDesktopAutostart({ adapter: mockAdapter, spec: testSpec, store }).then((result) => {
			expect(result.outcome).toBe('unchanged');
			expect(result.registered).toBe(true);
			expect(mockAdapter.register).not.toHaveBeenCalled();
		});
	});

	it('rewrites registration when spec paths mismatch (upgrade/relocation) (E-209)', () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter: AutostartAdapterBridge = {
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { supported: true, registered: true, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({ ok: true }),
			manualStartCommand: vi.fn().mockReturnValue('systemctl --user start daemon'),
		};

		return syncDesktopAutostart({ adapter: mockAdapter, spec: testSpec, store }).then((result) => {
			expect(result.outcome).toBe('rewritten');
			expect(result.registered).toBe(true);
			expect(mockAdapter.register).toHaveBeenCalledWith(testSpec);
		});
	});

	it('degrades non-fatally to manual command when registration denied (E-210)', () => {
		const store = new MemoryAutostartPreferenceStore();
		const mockAdapter: AutostartAdapterBridge = {
			status: vi.fn().mockResolvedValue({
				ok: true,
				value: { supported: true, registered: false, matchesSpec: false },
			}),
			register: vi.fn().mockResolvedValue({
				ok: false,
				error: { code: 'E_ACCESS_DENIED' },
			}),
			manualStartCommand: vi.fn().mockReturnValue('systemctl --user start daemon'),
		};

		return syncDesktopAutostart({ adapter: mockAdapter, spec: testSpec, store }).then((result) => {
			expect(result.outcome).toBe('failed');
			expect(result.registered).toBe(false);
			if (result.outcome === 'failed') {
				expect(result.manualCommand).toBe('systemctl --user start daemon');
			}
		});
	});

	describe('User externally disabled autostart (AC 5, E-208)', () => {
		it('detects external disablement and prompts user, re-registering if accepted', async () => {
			const store = new MemoryAutostartPreferenceStore();
			store.setWasPreviouslyConfigured(true);

			const mockAdapter: AutostartAdapterBridge = {
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { supported: true, registered: false, matchesSpec: false },
				}),
				register: vi.fn().mockResolvedValue({ ok: true }),
				manualStartCommand: vi.fn().mockReturnValue(''),
			};

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

			const mockAdapter: AutostartAdapterBridge = {
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { supported: true, registered: false, matchesSpec: false },
				}),
				register: vi.fn(),
				manualStartCommand: vi.fn().mockReturnValue(''),
			};

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

			const mockAdapter: AutostartAdapterBridge = {
				status: vi.fn().mockResolvedValue({
					ok: true,
					value: { supported: true, registered: false, matchesSpec: false },
				}),
				register: vi.fn(),
				manualStartCommand: vi.fn().mockReturnValue(''),
			};

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

			// Subsequent run: never calls promptUser
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
	});
});
