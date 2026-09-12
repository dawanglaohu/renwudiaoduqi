import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedToken, setCachedToken } from '../src/api/http-client.ts';
import {
	RouteGuard,
	hasDeviceToken,
	isPublicRoute,
	isRouteProtected,
} from '../src/app/route-guard.tsx';
import {
	ROUTES,
	ROUTE_PATHS,
	UnknownRouteView,
	buildPath,
	initializeHash,
	matchRoute,
	navigateTo,
	normalizeHash,
	safeDecodeParam,
} from '../src/app/routes.tsx';

describe('M9-T3 hash router and route guard', () => {
	beforeEach(() => {
		clearCachedToken();
		vi.restoreAllMocks();
	});

	describe('AC 1: Seven flat paths + two single-segment params (hash mode)', () => {
		it('exports ROUTE_PATHS and ROUTES matching the architecture spec', () => {
			expect(ROUTE_PATHS).toEqual({
				deck: '#/',
				tasks: '#/tasks',
				runDetail: '#/run/:runId',
				landing: '#/landing/:taskId',
				settingsAgents: '#/settings/agents',
				settingsDevices: '#/settings/devices',
				pair: '#/pair',
			});

			expect(ROUTES).toHaveLength(7);
			expect(ROUTES.map((r) => r.path)).toEqual([
				'#/',
				'#/tasks',
				'#/run/:runId',
				'#/landing/:taskId',
				'#/settings/agents',
				'#/settings/devices',
				'#/pair',
			]);

			// Pair is the only public route
			expect(ROUTES.find((r) => r.id === 'pair')?.auth).toBe(false);
			expect(ROUTES.filter((r) => r.auth)).toHaveLength(6);

			// Lazy chunks for settings and landing
			expect(ROUTES.find((r) => r.id === 'landing')?.lazy).toBe(true);
			expect(ROUTES.find((r) => r.id === 'settingsAgents')?.lazy).toBe(true);
			expect(ROUTES.find((r) => r.id === 'settingsDevices')?.lazy).toBe(true);

			// Main chunk routes
			expect(ROUTES.find((r) => r.id === 'deck')?.lazy).toBe(false);
			expect(ROUTES.find((r) => r.id === 'tasks')?.lazy).toBe(false);
			expect(ROUTES.find((r) => r.id === 'runDetail')?.lazy).toBe(false);
		});

		it('matches all seven flat paths correctly', () => {
			expect(matchRoute('#/')).toMatchObject({ id: 'deck', path: '#/', isUnknown: false });
			expect(matchRoute('#/tasks')).toMatchObject({
				id: 'tasks',
				path: '#/tasks',
				isUnknown: false,
			});
			expect(matchRoute('#/run/run-42')).toMatchObject({
				id: 'runDetail',
				path: '#/run/run-42',
				params: { runId: 'run-42' },
				isUnknown: false,
			});
			expect(matchRoute('#/landing/task-m9-t3')).toMatchObject({
				id: 'landing',
				path: '#/landing/task-m9-t3',
				params: { taskId: 'task-m9-t3' },
				isUnknown: false,
			});
			expect(matchRoute('#/settings/agents')).toMatchObject({
				id: 'settingsAgents',
				path: '#/settings/agents',
				isUnknown: false,
			});
			expect(matchRoute('#/settings/devices')).toMatchObject({
				id: 'settingsDevices',
				path: '#/settings/devices',
				isUnknown: false,
			});
			expect(matchRoute('#/pair')).toMatchObject({ id: 'pair', path: '#/pair', isUnknown: false });
		});

		it('parses single-segment parameter and decodes URI components', () => {
			const runMatch = matchRoute('#/run/run%2Fspecial-123');
			expect(runMatch.isUnknown).toBe(false);
			if (!runMatch.isUnknown) {
				expect(runMatch.params.runId).toBe('run/special-123');
			}

			const taskMatch = matchRoute('#/landing/task%3Am9-t3');
			expect(taskMatch.isUnknown).toBe(false);
			if (!taskMatch.isUnknown) {
				expect(taskMatch.params.taskId).toBe('task:m9-t3');
			}
		});

		it('parses hash query params without creating extra routes (e.g. #/?pane=tasks)', () => {
			const deckWithPane = matchRoute('#/?pane=tasks');
			expect(deckWithPane.isUnknown).toBe(false);
			expect(deckWithPane.id).toBe('deck');
			expect(deckWithPane.query).toEqual({ pane: 'tasks' });

			const runWithQuery = matchRoute('#/run/run-99?pane=detail&density=compact');
			expect(runWithQuery.isUnknown).toBe(false);
			expect(runWithQuery.id).toBe('runDetail');
			expect(runWithQuery.params).toEqual({ runId: 'run-99' });
			expect(runWithQuery.query).toEqual({ pane: 'detail', density: 'compact' });
		});

		it('exhibits identical behavior for the 3 loading sources (daemon /, tauri://localhost, https://localhost)', () => {
			// All 3 sources load with empty hash initially
			expect(matchRoute('http://localhost:7817/')).toMatchObject({ id: 'deck', path: '#/' });
			expect(matchRoute('tauri://localhost/')).toMatchObject({ id: 'deck', path: '#/' });
			expect(matchRoute('https://localhost/')).toMatchObject({ id: 'deck', path: '#/' });
		});
	});

	describe('AC 2 & E-222: Unknown hash handling and fallback view', () => {
		it('returns UnknownRoute for unregistered hash without throwing exceptions', () => {
			expect(() => matchRoute('#/xxx')).not.toThrow();
			const unknown1 = matchRoute('#/xxx');
			expect(unknown1.isUnknown).toBe(true);
			expect(unknown1.id).toBe('unknown');

			expect(() => matchRoute('#/unknown/nested/path')).not.toThrow();
			const unknown2 = matchRoute('#/unknown/nested/path');
			expect(unknown2.isUnknown).toBe(true);

			expect(() => matchRoute('#/settings')).not.toThrow();
			const unknown3 = matchRoute('#/settings');
			expect(unknown3.isUnknown).toBe(true);
		});

		it('marks missing single-segment parameters as unknown route (E-222)', () => {
			// #/run with missing parameter
			const runNoParam = matchRoute('#/run');
			expect(runNoParam.isUnknown).toBe(true);

			// #/run/ with empty parameter
			const runEmptyParam = matchRoute('#/run/');
			expect(runEmptyParam.isUnknown).toBe(true);

			// #/run/a/b with multi-segment parameter
			const runMultiSegment = matchRoute('#/run/a/b');
			expect(runMultiSegment.isUnknown).toBe(true);

			// #/landing with missing parameter
			const landingNoParam = matchRoute('#/landing');
			expect(landingNoParam.isUnknown).toBe(true);

			// #/landing/ with empty parameter
			const landingEmptyParam = matchRoute('#/landing/');
			expect(landingEmptyParam.isUnknown).toBe(true);
		});

		it('safely handles malformed percent-encoded parameters without throwing URIError (R1 regression, E-222)', () => {
			const malformedHashes = ['#/run/%', '#/run/%2', '#/run/%E0%A4%A', '#/landing/%zz'];

			for (const hash of malformedHashes) {
				expect(() => matchRoute(hash)).not.toThrow();
				const match = matchRoute(hash);
				expect(match.isUnknown).toBe(true);
				expect(match.id).toBe('unknown');
			}

			// Confirm missing or multi-segment parameters remain unknown routes
			expect(matchRoute('#/run/').isUnknown).toBe(true);
			expect(matchRoute('#/run').isUnknown).toBe(true);
			expect(matchRoute('#/run/a/b').isUnknown).toBe(true);

			// Direct safeDecodeParam assertions
			expect(safeDecodeParam('valid-id')).toBe('valid-id');
			expect(safeDecodeParam('foo%20bar')).toBe('foo bar');
			expect(safeDecodeParam('%')).toBeNull();
			expect(safeDecodeParam('%2')).toBeNull();
			expect(safeDecodeParam('%E0%A4%A')).toBeNull();
			expect(safeDecodeParam('%zz')).toBeNull();
		});

		it('renders UnknownRouteView with preserved topbar, "未知路径", and "回到运行甲板" button', () => {
			const match = matchRoute('#/invalid-path-123');
			const html = renderToStaticMarkup(createElement(UnknownRouteView, { match }));

			// Must preserve topbar
			expect(html).toContain('<header');
			expect(html).toContain('h-topbar');
			expect(html).toContain('Agent 任务调度器');

			// Must render unknown route heading
			expect(html).toContain('未知路径');
			expect(html).toContain('#/invalid-path-123');

			// Must provide "回到运行甲板" button
			expect(html).toContain('回到运行甲板');
		});
	});

	describe('AC 3 & E-223: Non-existent object parameters handled by page, not router', () => {
		it('matches route successfully even if runId or taskId does not exist (not a router 404)', () => {
			// Non-existent run ID still matches runDetail route
			const matchNonExistentRun = matchRoute('#/run/purged-run-99999');
			expect(matchNonExistentRun.isUnknown).toBe(false);
			expect(matchNonExistentRun.id).toBe('runDetail');
			expect(matchNonExistentRun.params.runId).toBe('purged-run-99999');

			// Non-existent task ID still matches landing route
			const matchRemovedTask = matchRoute('#/landing/removed-task-88888');
			expect(matchRemovedTask.isUnknown).toBe(false);
			expect(matchRemovedTask.id).toBe('landing');
			expect(matchRemovedTask.params.taskId).toBe('removed-task-88888');
		});
	});

	describe('AC 4 & E-224: Empty hash normalization on first load', () => {
		it('normalizes empty hash or "#" to "#/" immediately', () => {
			expect(normalizeHash('')).toBe('#/');
			expect(normalizeHash(null)).toBe('#/');
			expect(normalizeHash(undefined)).toBe('#/');
			expect(normalizeHash('#')).toBe('#/');
			expect(normalizeHash('#/')).toBe('#/');
			expect(normalizeHash('/')).toBe('#/');
			expect(normalizeHash('#?pane=tasks')).toBe('#/?pane=tasks');
		});

		it('initializeHash normalizes window.location.hash to "#/" without white screen', () => {
			const originalLocation = globalThis.location;
			let currentHash = '';
			const replaceSpy = vi.fn((newUrl: string) => {
				currentHash = newUrl;
			});

			// Mock window.location
			const mockLocation = {
				get hash() {
					return currentHash;
				},
				set hash(val: string) {
					currentHash = val;
				},
				replace: replaceSpy,
			};

			Object.defineProperty(globalThis, 'location', {
				value: mockLocation,
				writable: true,
				configurable: true,
			});

			try {
				currentHash = '';
				const result = initializeHash();
				expect(result).toBe('#/');
				expect(replaceSpy).toHaveBeenCalledWith('#/');
			} finally {
				Object.defineProperty(globalThis, 'location', {
					value: originalLocation,
					writable: true,
					configurable: true,
				});
			}
		});
	});

	describe('AC 5: navigateTo() and buildPath()', () => {
		it('buildPath produces valid hash paths with interpolated params and query', () => {
			expect(buildPath(ROUTE_PATHS.deck)).toBe('#/');
			expect(buildPath(ROUTE_PATHS.deck, undefined, { pane: 'tasks' })).toBe('#/?pane=tasks');
			expect(buildPath(ROUTE_PATHS.runDetail, { runId: 'run-42' })).toBe('#/run/run-42');
			expect(buildPath(ROUTE_PATHS.landing, { taskId: 'task-7' }, { tab: 'files' })).toBe(
				'#/landing/task-7?tab=files',
			);
		});

		it('navigateTo updates location.hash or invokes replace', () => {
			const originalLocation = globalThis.location;
			let currentHash = '#/';
			const replaceSpy = vi.fn((url: string) => {
				currentHash = url;
			});

			Object.defineProperty(globalThis, 'location', {
				value: {
					get hash() {
						return currentHash;
					},
					set hash(val: string) {
						currentHash = val;
					},
					replace: replaceSpy,
				},
				writable: true,
				configurable: true,
			});

			try {
				navigateTo('/tasks');
				expect(currentHash).toBe('#/tasks');

				navigateTo('#/run/run-1', { replace: true });
				expect(replaceSpy).toHaveBeenCalledWith('#/run/run-1');
			} finally {
				Object.defineProperty(globalThis, 'location', {
					value: originalLocation,
					writable: true,
					configurable: true,
				});
			}
		});
	});

	describe('RouteGuard (src/app/route-guard.tsx)', () => {
		it('hasDeviceToken returns true only when token exists in memory', () => {
			expect(hasDeviceToken()).toBe(false);
			setCachedToken('valid-device-token-123');
			expect(hasDeviceToken()).toBe(true);
			clearCachedToken();
			expect(hasDeviceToken()).toBe(false);
		});

		it('isPublicRoute identifies #/pair as the ONLY public route', () => {
			expect(isPublicRoute('pair')).toBe(true);
			expect(isPublicRoute('#/pair')).toBe(true);
			expect(isPublicRoute('#/pair?code=123')).toBe(true);
			expect(isPublicRoute(matchRoute('#/pair'))).toBe(true);

			expect(isPublicRoute('deck')).toBe(false);
			expect(isPublicRoute('#/')).toBe(false);
			expect(isPublicRoute('#/tasks')).toBe(false);
			expect(isPublicRoute('#/run/run-1')).toBe(false);
			expect(isPublicRoute('#/landing/task-1')).toBe(false);
			expect(isPublicRoute('#/settings/agents')).toBe(false);
			expect(isPublicRoute('#/settings/devices')).toBe(false);
		});

		it('isRouteProtected returns true for all non-pair routes', () => {
			expect(isRouteProtected('#/pair')).toBe(false);
			expect(isRouteProtected('#/')).toBe(true);
			expect(isRouteProtected('#/tasks')).toBe(true);
			expect(isRouteProtected('#/run/run-1')).toBe(true);
		});

		it('RouteGuard blocks protected routes when unauthenticated and renders pairing view', () => {
			clearCachedToken();
			const protectedContent = createElement('div', { 'data-testid': 'secret' }, 'SECRET_PAGE');

			const rendered = renderToStaticMarkup(
				createElement(
					RouteGuard,
					{ currentRoute: '#/tasks', hasToken: () => false },
					protectedContent,
				),
			);

			// Protected content MUST NOT be rendered
			expect(rendered).not.toContain('SECRET_PAGE');
			// Pairing prompt must be rendered
			expect(rendered).toContain('需要设备配对');
			expect(rendered).toContain('前往配对');
		});

		it('RouteGuard allows public #/pair route even when unauthenticated', () => {
			clearCachedToken();
			const pairPageContent = createElement('div', { 'data-testid': 'pair-page' }, 'PAIRING_PAGE');

			const rendered = renderToStaticMarkup(
				createElement(
					RouteGuard,
					{ currentRoute: '#/pair', hasToken: () => false },
					pairPageContent,
				),
			);

			expect(rendered).toContain('PAIRING_PAGE');
		});

		it('RouteGuard allows protected routes when authenticated with device token', () => {
			setCachedToken('test-token');
			const protectedContent = createElement('div', { 'data-testid': 'secret' }, 'SECRET_PAGE');

			const rendered = renderToStaticMarkup(
				createElement(
					RouteGuard,
					{ currentRoute: '#/tasks', hasToken: () => true },
					protectedContent,
				),
			);

			expect(rendered).toContain('SECRET_PAGE');
		});
	});
});
