// @vitest-environment jsdom

import type { AgentEntryDto, ListAgentsResponse } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { clearResourceCache, refetchAll } from '../src/api/resource-cache.ts';
import { useSettingsAgents } from '../src/features/settings-agents/use-settings-agents.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent: AgentEntryDto = {
	id: 'codex',
	name: 'Codex',
	monogram: 'CX',
	isAvailable: true,
	defaultModel: 'old-model',
	defaultEffortTier: null,
	maxConcurrency: 1,
	permissionTier: 'workspaceWrite',
	execPath: '/usr/bin/codex',
	login: {
		state: 'unknown',
		reason: 'unparsable',
		checkedAt: '2026-10-01T00:00:00Z',
		loginCommand: null,
		warningCode: null,
	},
};

beforeEach(() => {
	clearResourceCache();
	localStorage.clear();
});
afterEach(() => {
	clearResourceCache();
	vi.restoreAllMocks();
});

it('reloads AgentEntryDto login and effective layers after the refresh milestone (E-335/E-358)', async () => {
	const updated = {
		...agent,
		defaultModel: 'new-model',
		login: {
			...agent.login,
			state: 'logged_in' as const,
			reason: null,
			checkedAt: '2026-10-02T00:00:00Z',
			loginCommand: null,
			warningCode: null,
		},
	};
	const readAgents = vi
		.spyOn(httpClient, 'callRoute')
		.mockResolvedValueOnce({ agents: [agent] } satisfies ListAgentsResponse)
		.mockResolvedValueOnce({ documents: [] })
		.mockResolvedValueOnce({ agents: [updated] } satisfies ListAgentsResponse);
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	function View() {
		const result = useSettingsAgents();
		return createElement(
			'output',
			null,
			`${result.agents[0]?.login?.checkedAt}/${result.agents[0]?.defaultModel}`,
		);
	}
	try {
		await act(async () => root.render(createElement(View)));
		expect(container.textContent).toBe('2026-10-01T00:00:00Z/old-model');
		await act(async () =>
			eventBus.push({
				id: 901,
				kind: 'agent.availability_changed',
				scope: 'agent',
				runId: null,
				ts: '2026-10-02T00:00:00Z',
				actorDeviceId: null,
				taskId: null,
				seq: 1,
				payload: {
					agentId: 'codex',
					available: true,
					reason: 'login_changed',
					login: updated.login,
				},
			}),
		);
		expect(readAgents).toHaveBeenCalledTimes(3);
		expect(container.textContent).toBe('2026-10-02T00:00:00Z/new-model');
		expect(
			readAgents.mock.calls
				.filter(([route]) => route.path === '/api/v1/agents')
				.every(([route]) => route.method === 'GET' && route.path === '/api/v1/agents'),
		).toBe(true);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it('keeps failed clearOverrides intact and receives reconnect reads from the shared cache (E-358)', async () => {
	const original = {
		...agent,
		layers: {
			defaultModel: { builtin: null, config: 'configured', override: 'custom', hasOverride: true },
		},
	};
	const restored = { ...original, defaultModel: 'latest' };
	vi.spyOn(httpClient, 'callRoute')
		.mockResolvedValueOnce({ agents: [original] })
		.mockResolvedValueOnce({ documents: [] })
		.mockRejectedValueOnce(new Error('PATCH failed'))
		.mockResolvedValueOnce({ agents: [restored] });
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	let result: ReturnType<typeof useSettingsAgents> | undefined;
	function View() {
		result = useSettingsAgents();
		return null;
	}
	try {
		await act(async () => root.render(createElement(View)));
		await act(async () => {
			expect(await result?.clearAgentOverride('codex', 'defaultModel')).toBe(false);
		});
		expect(result?.agents[0]?.layers?.defaultModel).toEqual(original.layers.defaultModel);
		await act(async () => {
			await refetchAll();
		});
		expect(result?.agents[0]?.defaultModel).toBe('latest');
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it('does not publish a superseded GET when a milestone invalidates it (E-339)', async () => {
	let resolveOld: ((response: ListAgentsResponse) => void) | undefined;
	const oldRead = new Promise<ListAgentsResponse>((resolve) => {
		resolveOld = resolve;
	});
	const latest = { ...agent, defaultModel: 'latest-model' };
	const request = vi
		.spyOn(httpClient, 'callRoute')
		.mockReturnValueOnce(oldRead)
		.mockResolvedValueOnce({ documents: [] })
		.mockResolvedValueOnce({ agents: [latest] });
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	const seen: string[] = [];
	function View() {
		const state = useSettingsAgents();
		if (state.agents[0]) seen.push(state.agents[0].defaultModel ?? '');
		return null;
	}
	try {
		await act(async () => root.render(createElement(View)));
		await act(async () => {
			eventBus.push({
				id: 902,
				ts: '2026-10-02T00:00:00Z',
				runId: null,
				taskId: null,
				scope: 'agent',
				kind: 'agent.availability_changed',
				seq: 2,
				actorDeviceId: null,
				payload: { agentId: 'codex', available: true, reason: 'login_changed' },
			});
			resolveOld?.({ agents: [agent] });
		});
		expect(request).toHaveBeenCalledTimes(3);
		expect(seen).toContain('latest-model');
		expect(seen).not.toContain('old-model');
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
