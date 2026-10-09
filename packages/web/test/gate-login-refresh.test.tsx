// @vitest-environment jsdom
import type { LoginState } from '@agent-scheduler/shared/api/agents';
import type { GateDto, ListGatesResponse } from '@agent-scheduler/shared/api/gates';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { RunDeckContainer } from '../src/features/run-deck/run-deck-container.tsx';

const unchecked: LoginState = {
	state: 'unknown',
	reason: 'unparsable',
	checkedAt: null,
	loginCommand: 'codex login',
	warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
};

function gate(login: LoginState): GateDto {
	return {
		id: 'g-zero',
		taskId: 't-zero',
		runId: 'r-zero',
		kind: 'review',
		state: 'waiting',
		decision: null,
		comment: null,
		decidedByDeviceId: null,
		createdAt: '2026-10-09T00:00:00Z',
		decidedAt: null,
		context: {
			exitCode: 1,
			exitSignal: null,
			stderrTail: { kind: 'lines', lines: ['invalid model'] },
			login,
		},
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: Error) => void = () => {};
	const promise = new Promise<T>((finish, fail) => {
		resolve = finish;
		reject = fail;
	});
	return { promise, resolve, reject };
}

let eventId = 200;
function loginChanged(reason = 'login_changed') {
	eventBus.push({
		id: ++eventId,
		ts: new Date().toISOString(),
		scope: 'agent',
		kind: 'agent.availability_changed',
		runId: null,
		taskId: null,
		seq: 1,
		actorDeviceId: null,
		payload: { agentId: 'codex', available: true, reason },
	});
}

function mountDeck(options: { empty?: boolean } = {}) {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	let gates = options.empty ? [] : [gate(unchecked)];
	let readGates: () => Promise<ListGatesResponse> = async () => ({ gates });
	let readRuns = async () => ({ runs: [] });
	const snapshot: SnapshotResponse = {
		documents: [],
		batches: [
			{
				id: 'b1',
				docId: 'd1',
				batchNo: 1,
				state: 'running',
				startedAt: null,
				finishedAt: null,
				defaultExpanded: true,
			},
		],
		tasks: [
			{
				id: 't-zero',
				taskKey: 'TEST-T1',
				title: 'Zero output',
				batchId: 'b1',
				docId: 'd1',
				state: 'awaiting_human',
				deps: [],
				moduleKey: 'M9',
				estDays: 1,
			} as TaskDto,
		],
		runs: [],
		gates: [],
		agents: [],
		lanes: [],
		latestEventId: 200,
	};
	let readSnapshot = async () =>
		options.empty ? { ...snapshot, tasks: [], batches: [] } : snapshot;
	const calls = vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route) => {
		switch (route.path) {
			case '/api/v1/snapshot':
				return readSnapshot();
			case '/api/v1/runs':
				return readRuns();
			case '/api/v1/gates':
				return readGates();
			case '/api/v1/documents':
				return { documents: [] };
			case '/api/v1/agents':
				return { agents: [] };
			default:
				throw new Error(`Unexpected request: ${route.path}`);
		}
	});
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	return {
		calls,
		container,
		badgeTitle: () => container.querySelector('[data-testid="login-badge"]')?.getAttribute('title'),
		setLogin: (login: LoginState) => {
			gates = [gate(login)];
		},
		setGateReader: (read: typeof readGates) => {
			readGates = read;
		},
		setRunReader: (read: typeof readRuns) => {
			readRuns = read;
		},
		setSnapshotReader: (read: typeof readSnapshot = async () => snapshot) => {
			readSnapshot = read;
		},
		mount: () =>
			act(async () =>
				root.render(createElement(RunDeckContainer, { lanes: [], densityTier: 'full' })),
			),
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('updates the mounted zero-output card after login probing without snapshot reads or probe requests', async () => {
	const deck = mountDeck();
	try {
		await deck.mount();
		expect(deck.badgeTitle()).toBe('—');
		const before = deck.calls.mock.calls.length;
		deck.setLogin({ ...unchecked, checkedAt: new Date().toISOString() });
		await act(async () => loginChanged('exec_changed'));
		expect(deck.calls.mock.calls).toHaveLength(before);
		await act(async () => loginChanged());
		expect(deck.badgeTitle()).toBe('刚刚');
		expect(
			deck.calls.mock.calls
				.slice(before)
				.map(([route, options]) => [route.method, route.path, options]),
		).toEqual([['GET', '/api/v1/gates', undefined]]);
		expect(deck.container.querySelector('[data-component="gate-card"]')).not.toBeNull();
		expect(deck.container.textContent).toContain('invalid model');
	} finally {
		await deck.unmount();
	}
});

it('discards a gate read overtaken by a later completed login probe', async () => {
	const deck = mountDeck();
	try {
		await deck.mount();
		const stale = deferred<ListGatesResponse>();
		const fresh = deferred<ListGatesResponse>();
		let reads = 0;
		deck.setGateReader(() => (++reads === 1 ? stale.promise : fresh.promise));
		const before = deck.calls.mock.calls.length;
		await act(async () => {
			loginChanged();
			loginChanged();
		});
		expect(reads).toBe(1);
		await act(async () => loginChanged());
		await act(async () =>
			stale.resolve({ gates: [gate({ ...unchecked, checkedAt: '2020-01-01T00:00:00Z' })] }),
		);
		expect(deck.badgeTitle()).toBe('—');
		expect(reads).toBe(2);
		await act(async () =>
			fresh.resolve({ gates: [gate({ ...unchecked, checkedAt: new Date().toISOString() })] }),
		);
		expect(deck.badgeTitle()).toBe('刚刚');
		expect(
			deck.calls.mock.calls.slice(before).every(([route]) => route.path === '/api/v1/gates'),
		).toBe(true);
	} finally {
		await deck.unmount();
	}
});

it('keeps the refreshed context when an earlier full deck read finishes later', async () => {
	const deck = mountDeck();
	try {
		await deck.mount();
		const delayedRuns = deferred<{ runs: never[] }>();
		deck.setRunReader(() => delayedRuns.promise);
		await act(async () =>
			eventBus.push({
				id: ++eventId,
				ts: new Date().toISOString(),
				scope: 'run',
				kind: 'run.exited',
				runId: 'r-zero',
				taskId: 't-zero',
				seq: 2,
				actorDeviceId: null,
				payload: { exitCode: 1, exitSignal: null },
			}),
		);
		const before = deck.calls.mock.calls.length;
		deck.setLogin({ ...unchecked, checkedAt: new Date().toISOString() });
		await act(async () => loginChanged());
		expect(deck.badgeTitle()).toBe('刚刚');
		await act(async () => delayedRuns.resolve({ runs: [] }));
		expect(deck.badgeTitle()).toBe('刚刚');
		expect(deck.calls.mock.calls.slice(before).map(([route]) => route.path)).toEqual([
			'/api/v1/gates',
		]);
	} finally {
		await deck.unmount();
	}
});

it('replaces an invalidated failed gate read with the latest probe context', async () => {
	const deck = mountDeck();
	try {
		await deck.mount();
		const stale = deferred<ListGatesResponse>();
		let reads = 0;
		deck.setGateReader(() =>
			++reads === 1
				? stale.promise
				: Promise.resolve({ gates: [gate({ ...unchecked, checkedAt: new Date().toISOString() })] }),
		);
		await act(async () => loginChanged());
		await act(async () => loginChanged());
		await act(async () => stale.reject(new Error('outdated gate read failed')));
		expect(reads).toBe(2);
		expect(deck.badgeTitle()).toBe('刚刚');
		expect(deck.container.textContent).not.toContain('outdated gate read failed');
	} finally {
		await deck.unmount();
	}
});

it('stops the invalidated gate read when the container unmounts', async () => {
	const deck = mountDeck();
	await deck.mount();
	const stale = deferred<ListGatesResponse>();
	let reads = 0;
	deck.setGateReader(() => {
		reads += 1;
		return stale.promise;
	});
	await act(async () => loginChanged());
	await act(async () => loginChanged());
	await deck.unmount();
	await act(async () => stale.resolve({ gates: [gate(unchecked)] }));
	expect(reads).toBe(1);
});

function deckMilestone() {
	eventBus.push({
		id: ++eventId,
		ts: new Date().toISOString(),
		scope: 'task',
		kind: 'task.gate_waiting',
		runId: 'r-zero',
		taskId: 't-zero',
		seq: 2,
		actorDeviceId: null,
		payload: { gate: 'g-zero' },
	});
}

it('loads the new approval when a deck milestone overtakes a focused gate read', async () => {
	const deck = mountDeck({ empty: true });
	try {
		await deck.mount();
		expect(deck.container.querySelector('[data-component="gate-card"]')).toBeNull();
		const stale = deferred<ListGatesResponse>();
		let reads = 0;
		deck.setGateReader(() =>
			++reads === 1 ? stale.promise : Promise.resolve({ gates: [gate(unchecked)] }),
		);
		await act(async () => loginChanged());
		deck.setSnapshotReader();
		await act(async () => deckMilestone());
		await act(async () => stale.resolve({ gates: [] }));
		expect(deck.container.querySelector('[data-component="gate-card"]')).not.toBeNull();
		expect(reads).toBe(2);
	} finally {
		await deck.unmount();
	}
});

it('restores onboarding after a focused gate failure recovers', async () => {
	const deck = mountDeck({ empty: true });
	try {
		await deck.mount();
		expect(deck.container.querySelector('[data-testid="deck-setup"]')).not.toBeNull();
		deck.setGateReader(async () => {
			throw new Error('focused gate read failed');
		});
		await act(async () => loginChanged());
		expect(deck.container.querySelector('[data-testid="deck-setup"]')).toBeNull();
		deck.setGateReader(async () => ({ gates: [] }));
		await act(async () => loginChanged());
		expect(deck.container.querySelector('[data-testid="deck-setup"]')).not.toBeNull();
		expect(deck.container.textContent).not.toContain('focused gate read failed');
	} finally {
		await deck.unmount();
	}
});

it('preserves a full-deck lane-data failure when a focused gate read succeeds', async () => {
	const deck = mountDeck({ empty: true });
	try {
		await deck.mount();
		deck.setSnapshotReader(async () => {
			throw new Error('泳道数据不可用');
		});
		await act(async () => deckMilestone());
		expect(deck.container.querySelector('[data-testid="deck-setup"]')).toBeNull();
		await act(async () => loginChanged());
		expect(deck.container.querySelector('[data-testid="deck-setup"]')).toBeNull();
		expect(deck.container.textContent).toContain('泳道数据不可用');
	} finally {
		await deck.unmount();
	}
});
