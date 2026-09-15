import { CURRENT_API_VERSION, type VersionResponse } from '@agent-scheduler/shared/api/system';
import { describe, expect, it } from 'vitest';
import { createConnectionUiController } from '../src/connection-ui.ts';
import { createDesktopStartupContext } from '../src/launch-spec.ts';
import {
	checkDesktopApiVersion,
	extractMajorVersion,
	generateVersionIncompatibleHtml,
	isApiVersionCompatible,
} from '../src/version-check.ts';

const STARTUP_BASE = {
	currentExe: '/opt/scheduler/bin/scheduler',
	resourceDir: '/opt/scheduler/lib',
	hostPlatform: 'linux',
};

function versionBody(overrides: Partial<VersionResponse> = {}): VersionResponse {
	return {
		daemon: '0.1.0',
		apiVersion: CURRENT_API_VERSION,
		node: '22.17.0',
		...overrides,
	};
}

describe('Desktop Shell Version Check & Compatibility (AC 1, E-14)', () => {
	describe('extractMajorVersion', () => {
		it('extracts major version number correctly from semver and v-prefixed strings', () => {
			expect(extractMajorVersion('v1')).toBe(1);
			expect(extractMajorVersion('V1')).toBe(1);
			expect(extractMajorVersion('1.0.0')).toBe(1);
			expect(extractMajorVersion('v1.2.3')).toBe(1);
			expect(extractMajorVersion('v2')).toBe(2);
			expect(extractMajorVersion('2.4.0')).toBe(2);
			expect(extractMajorVersion('0.9.1')).toBe(0);
		});

		it('returns NaN for invalid or empty inputs', () => {
			expect(Number.isNaN(extractMajorVersion(''))).toBe(true);
			expect(Number.isNaN(extractMajorVersion('unknown'))).toBe(true);
		});
	});

	describe('isApiVersionCompatible', () => {
		it('returns true when detected version matches supported API version', () => {
			expect(isApiVersionCompatible('v1', 'v1')).toBe(true);
			expect(isApiVersionCompatible('1.0.0', 'v1')).toBe(true);
			expect(isApiVersionCompatible('v1.5.0', '1.0.0')).toBe(true);
			expect(isApiVersionCompatible(CURRENT_API_VERSION)).toBe(true);
		});

		it('AC 1 & E-14: returns false when major versions differ (incompatible API versions)', () => {
			expect(isApiVersionCompatible('v2', 'v1')).toBe(false);
			expect(isApiVersionCompatible('2.0.0', 'v1')).toBe(false);
			expect(isApiVersionCompatible('v0', 'v1')).toBe(false);
			expect(isApiVersionCompatible('0.9.0', 'v1')).toBe(false);
		});

		it('returns false for null, undefined, or empty string without throwing', () => {
			expect(isApiVersionCompatible(null)).toBe(false);
			expect(isApiVersionCompatible(undefined)).toBe(false);
			expect(isApiVersionCompatible('')).toBe(false);
		});
	});

	describe('checkDesktopApiVersion', () => {
		it('AC 1: returns compatible true when daemon apiVersion matches client expected version', async () => {
			const mockFetcher = async () =>
				new Response(JSON.stringify(versionBody()), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			const result = await checkDesktopApiVersion({
				fetcher: mockFetcher,
				baseUrl: 'http://lan-host:7817',
			});

			expect(result.compatible).toBe(true);
			if (result.compatible) {
				expect(result.apiVersion).toBe(CURRENT_API_VERSION);
				expect(result.daemonVersion).toBe('0.1.0');
				expect(result.nodeVersion).toBe('22.17.0');
			}
		});

		it('treats missing baseUrl as unreachable without guessing loopback', async () => {
			const result = await checkDesktopApiVersion({
				baseUrl: null,
				fetcher: async () => {
					throw new Error('fetcher must not run without a host hint');
				},
			});
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('unreachable');
				expect(result.upgradePrompt).toContain('电脑上的调度服务未启动');
			}
		});

		it('AC 1 & E-14: prompts upgrade instead of throwing when apiVersion is incompatible', async () => {
			const mockFetcher = async () =>
				new Response(JSON.stringify(versionBody({ apiVersion: 'v2', daemon: '0.2.0' })), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			const result = await checkDesktopApiVersion({
				fetcher: mockFetcher,
				baseUrl: 'http://lan-host:7817',
				expectedVersion: CURRENT_API_VERSION,
			});

			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('incompatible');
				expect(result.apiVersion).toBe('v2');
				expect(result.expectedVersion).toBe(CURRENT_API_VERSION);
				expect(result.upgradePrompt).toContain('两端版本不一致');
				expect(result.upgradePrompt).toContain('升级');
			}
		});

		it('AC 1 & E-14: handles daemon unreachable/offline gracefully without throwing bottom-level errors', async () => {
			const mockFetcher = async () => {
				throw new Error('ECONNREFUSED lan-host:7817');
			};

			const result = await checkDesktopApiVersion({
				fetcher: mockFetcher,
				baseUrl: 'http://lan-host:7817',
			});

			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('unreachable');
				expect(result.message).toContain('Unable to connect');
				expect(result.upgradePrompt).toContain('调度服务未运行');
			}
		});

		it('handles malformed non-JSON or non-200 responses gracefully without throwing', async () => {
			const mockFetcher500 = async () => new Response('Internal Server Error', { status: 500 });

			const result500 = await checkDesktopApiVersion({
				fetcher: mockFetcher500,
				baseUrl: 'http://lan-host:7817',
			});
			expect(result500.compatible).toBe(false);
			if (!result500.compatible) {
				expect(result500.reason).toBe('malformed');
			}

			const mockFetcherBadJson = async () =>
				new Response('Not Valid JSON {', {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			const resultBadJson = await checkDesktopApiVersion({
				fetcher: mockFetcherBadJson,
				baseUrl: 'http://lan-host:7817',
			});
			expect(resultBadJson.compatible).toBe(false);
			if (!resultBadJson.compatible) {
				expect(resultBadJson.reason).toBe('malformed');
			}

			const mockFetcherMissingApiVersion = async () =>
				new Response(JSON.stringify({ daemon: '0.1.0' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			const resultMissingField = await checkDesktopApiVersion({
				fetcher: mockFetcherMissingApiVersion,
				baseUrl: 'http://lan-host:7817',
			});
			expect(resultMissingField.compatible).toBe(false);
			if (!resultMissingField.compatible) {
				expect(resultMissingField.reason).toBe('malformed');
			}
		});
	});

	describe('generateVersionIncompatibleHtml (E-14 UI)', () => {
		it('generates well-formed HTML displaying server version, expected version, and upgrade advice', () => {
			const html = generateVersionIncompatibleHtml({
				apiVersion: 'v2',
				expectedVersion: CURRENT_API_VERSION,
				baseUrl: 'http://lan-host:7817',
			});

			expect(html).toContain('E-14');
			expect(html).toContain('两端版本不兼容，需要升级');
			expect(html).toContain('v2');
			expect(html).toContain(CURRENT_API_VERSION);
			expect(html).toContain('http://lan-host:7817');
			expect(html).toContain('--page: #0F1213');
			expect(html).toContain('--needs: #F0B03C');
			expect(html).toContain('--font-mono');
		});
	});

	describe('createDesktopStartupContext version wiring (AC 1, E-14, R3)', () => {
		it('v2 response sets incompatible and yields upgrade HTML', async () => {
			const fetcher = async () =>
				new Response(JSON.stringify(versionBody({ apiVersion: 'v2' })), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			const context = createDesktopStartupContext({
				...STARTUP_BASE,
				hostHint: () => 'http://lan-host:7817',
				versionFetcher: fetcher,
			});
			const result = await context.versionCheckPromise;
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('incompatible');
			}
			expect(context.connectionController.getState().status).toBe('incompatible');
			const html = generateVersionIncompatibleHtml({
				apiVersion: 'v2',
				expectedVersion: CURRENT_API_VERSION,
				baseUrl: 'http://lan-host:7817',
			});
			expect(html).toContain('两端版本不兼容，需要升级');
		});

		it('HTTP 500 or bad JSON is malformed, never thrown', async () => {
			const context = createDesktopStartupContext({
				...STARTUP_BASE,
				hostHint: () => 'http://lan-host:7817',
				versionFetcher: async () => new Response('Internal Server Error', { status: 500 }),
			});
			const result = await context.versionCheckPromise;
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('malformed');
			}
		});

		it('network failure is unreachable without a reconnect loop', async () => {
			const context = createDesktopStartupContext({
				...STARTUP_BASE,
				hostHint: () => 'http://lan-host:7817',
				versionFetcher: async () => {
					throw new Error('network down');
				},
			});
			const result = await context.versionCheckPromise;
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('unreachable');
			}
		});
	});

	describe('createConnectionUiController version integration (AC 1, E-14)', () => {
		it('supports transition to incompatible status with apiVersion details', () => {
			const spec = {
				file: '/opt/agsched/daemon',
				args: [],
				cwd: '/opt/agsched',
			};

			const controller = createConnectionUiController(spec);
			expect(controller.getState().status).toBe('idle');

			controller.setIncompatible('v2', CURRENT_API_VERSION);
			const state = controller.getState();
			expect(state.status).toBe('incompatible');
			expect(state.apiVersion).toBe('v2');
			expect(state.expectedVersion).toBe(CURRENT_API_VERSION);
			expect(state.errorMessage).toContain('API version mismatch');
		});
	});
});
