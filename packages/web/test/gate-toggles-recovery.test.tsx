// @vitest-environment jsdom
import type {
	GateSettings,
	UpdateGateSettingsResponse,
} from '@agent-scheduler/shared/api/settings';
import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { GateTogglesContainer } from '../src/features/run-deck/gate-toggles-container.tsx';
import { triggerResync, useConnectionStore } from '../src/store/connection-store.ts';

const manual: GateSettings = { dispatch: 'manual', review: 'manual', landing: 'manual' };
const automaticLanding: GateSettings = { ...manual, landing: 'auto' };

function gatesChanged(gates: GateSettings, actorDeviceId = 'another-device'): void {
	eventBus.push({
		id: 101,
		ts: '2026-10-02T00:00:00.000Z',
		kind: 'settings.gates_changed',
		scope: 'settings',
		runId: null,
		taskId: null,
		actorDeviceId,
		seq: 1,
		payload: { gates },
	});
}

describe('M9-T19 gate settings authority and connection recovery', () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
		useConnectionStore.getState().reset();
		container = document.createElement('div');
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
		sessionStorage.clear();
	});

	function landingAuto(): HTMLButtonElement {
		const button = container.querySelector<HTMLButtonElement>(
			'[data-gate-toggle="landing"] button:nth-of-type(2)',
		);
		if (!button) throw new Error('Missing landing auto switch');
		return button;
	}

	it('does not let a late initial GET overwrite a newer authoritative SSE event', async () => {
		let finishRead: (response: UpdateGateSettingsResponse) => void = () => {};
		const pendingRead = new Promise<UpdateGateSettingsResponse>((resolve) => {
			finishRead = resolve;
		});
		await act(async () => {
			root.render(createElement(GateTogglesContainer, { fetcher: () => pendingRead }));
		});
		await act(async () => gatesChanged(automaticLanding));
		expect(landingAuto().getAttribute('data-state')).toBe('active');
		await act(async () => finishRead({ gates: manual }));
		expect(landingAuto().getAttribute('data-state')).toBe('active');
	});

	it('recovers a committed PATCH after its SSE event was lost during a disconnect', async () => {
		const fetcher = vi.fn(async () => ({ gates: automaticLanding }));
		const patcher = vi.fn(async () => ({ gates: automaticLanding }));
		await act(async () => {
			root.render(createElement(GateTogglesContainer, { initialGates: manual, fetcher, patcher }));
		});
		await act(async () => landingAuto().click());
		expect(patcher).toHaveBeenCalledOnce();
		expect(
			container.querySelector('[data-component="gate-toggles"]')?.getAttribute('data-pending'),
		).toBe('true');
		await act(async () => triggerResync());
		expect(fetcher).toHaveBeenCalledOnce();
		expect(landingAuto().getAttribute('data-state')).toBe('active');
		expect(landingAuto().disabled).toBe(false);
	});

	it('waits for an in-flight PATCH before reading recovery state', async () => {
		let finishWrite: (response: UpdateGateSettingsResponse) => void = () => {};
		const patcher = () =>
			new Promise<UpdateGateSettingsResponse>((resolve) => {
				finishWrite = resolve;
			});
		const fetcher = vi.fn(async () => ({ gates: automaticLanding }));
		await act(async () => {
			root.render(createElement(GateTogglesContainer, { initialGates: manual, fetcher, patcher }));
		});
		await act(async () => landingAuto().click());
		const recovery = triggerResync();
		expect(fetcher).not.toHaveBeenCalled();
		expect(landingAuto().disabled).toBe(true);
		await act(async () => {
			finishWrite({ gates: automaticLanding });
			await recovery;
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(landingAuto().getAttribute('data-state')).toBe('active');
		expect(landingAuto().disabled).toBe(false);
		await act(async () => gatesChanged(automaticLanding));
		expect(landingAuto().getAttribute('data-state')).toBe('active');
		expect(landingAuto().disabled).toBe(false);
	});

	it('preserves an SSE update received while a recovery GET is in flight', async () => {
		let finishRead: (response: UpdateGateSettingsResponse) => void = () => {};
		const fetcher = () =>
			new Promise<UpdateGateSettingsResponse>((resolve) => {
				finishRead = resolve;
			});
		await act(async () => {
			root.render(createElement(GateTogglesContainer, { initialGates: manual, fetcher }));
		});
		const recovery = triggerResync();
		await act(async () => gatesChanged(automaticLanding));
		await act(async () => {
			finishRead({ gates: manual });
			await recovery;
		});
		expect(landingAuto().getAttribute('data-state')).toBe('active');
	});

	it('does not unlock a pending write for another device or before HTTP completes', async () => {
		sessionStorage.setItem('agsched.current_device_id', 'current-device');
		let finishWrite: (response: UpdateGateSettingsResponse) => void = () => {};
		const patcher = () =>
			new Promise<UpdateGateSettingsResponse>((resolve) => {
				finishWrite = resolve;
			});
		await act(async () => {
			root.render(createElement(GateTogglesContainer, { initialGates: manual, patcher }));
		});
		await act(async () => landingAuto().click());
		await act(async () => gatesChanged(automaticLanding));
		expect(landingAuto().disabled).toBe(true);
		await act(async () => gatesChanged(automaticLanding, 'current-device'));
		expect(landingAuto().disabled).toBe(true);
		await act(async () => finishWrite({ gates: automaticLanding }));
		expect(landingAuto().disabled).toBe(false);
	});

	it('finishes recovery when a newer device event invalidates the first recovery read', async () => {
		sessionStorage.setItem('agsched.current_device_id', 'current-device');
		let finishRead: (response: UpdateGateSettingsResponse) => void = () => {};
		const newest: GateSettings = { ...manual, review: 'auto' };
		const fetcher = vi
			.fn<() => Promise<UpdateGateSettingsResponse>>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishRead = resolve;
					}),
			)
			.mockResolvedValue({ gates: newest });
		await act(async () => {
			root.render(
				createElement(GateTogglesContainer, {
					initialGates: manual,
					fetcher,
					patcher: async () => ({ gates: automaticLanding }),
				}),
			);
		});
		await act(async () => landingAuto().click());
		const recovery = triggerResync();
		await act(async () => gatesChanged(newest));
		await act(async () => {
			finishRead({ gates: automaticLanding });
			await recovery;
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(landingAuto().getAttribute('data-state')).not.toBe('active');
		expect(landingAuto().disabled).toBe(false);
	});
});
