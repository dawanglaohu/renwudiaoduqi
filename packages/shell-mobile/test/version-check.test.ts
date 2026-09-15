import { CURRENT_API_VERSION, type VersionResponse } from '@agent-scheduler/shared/api/system';
import { describe, expect, it } from 'vitest';
import { initializeMobileShell } from '../src/mobile-bridge.ts';
import {
	checkMobileApiVersion,
	extractMajorVersion,
	generateMobileUpgradeNotice,
	isMobileApiVersionCompatible,
} from '../src/version-check.ts';

function versionBody(overrides: Partial<VersionResponse> = {}): VersionResponse {
	return {
		daemon: '0.1.0',
		apiVersion: CURRENT_API_VERSION,
		node: '22.17.0',
		...overrides,
	};
}

const mockStorage = {
	store: new Map<string, string>([['agsched.host', 'http://192.168.1.50:7817']]),
	async get({ key }: { key: string }) {
		return { value: this.store.get(key) ?? null };
	},
	async set({ key, value }: { key: string; value: string }) {
		this.store.set(key, value);
	},
	async remove({ key }: { key: string }) {
		this.store.delete(key);
	},
};

describe('Mobile Shell Version Check & Compatibility (AC 1, E-14)', () => {
	describe('extractMajorVersion', () => {
		it('extracts major version number correctly from version strings', () => {
			expect(extractMajorVersion('v1')).toBe(1);
			expect(extractMajorVersion('1.0.0')).toBe(1);
			expect(extractMajorVersion('v2')).toBe(2);
			expect(extractMajorVersion('2.0.0')).toBe(2);
			expect(extractMajorVersion('0.1.0')).toBe(0);
		});

		it('returns NaN for invalid or empty inputs', () => {
			expect(Number.isNaN(extractMajorVersion(''))).toBe(true);
			expect(Number.isNaN(extractMajorVersion('invalid'))).toBe(true);
		});
	});

	describe('isMobileApiVersionCompatible', () => {
		it('returns true when detected server version matches expected API version', () => {
			expect(isMobileApiVersionCompatible('v1', 'v1')).toBe(true);
			expect(isMobileApiVersionCompatible('1.0.0', 'v1')).toBe(true);
			expect(isMobileApiVersionCompatible('v1.2.0', '1.0.0')).toBe(true);
			expect(isMobileApiVersionCompatible(CURRENT_API_VERSION)).toBe(true);
		});

		it('AC 1 & E-14: returns false when major versions mismatch (incompatible)', () => {
			expect(isMobileApiVersionCompatible('v2', 'v1')).toBe(false);
			expect(isMobileApiVersionCompatible('2.0.0', 'v1')).toBe(false);
			expect(isMobileApiVersionCompatible('v0', 'v1')).toBe(false);
			expect(isMobileApiVersionCompatible('0.5.0', 'v1')).toBe(false);
		});

		it('returns false for null, undefined, or empty string without throwing', () => {
			expect(isMobileApiVersionCompatible(null)).toBe(false);
			expect(isMobileApiVersionCompatible(undefined)).toBe(false);
			expect(isMobileApiVersionCompatible('')).toBe(false);
		});
	});

	describe('checkMobileApiVersion', () => {
		it('AC 1: returns compatible true when daemon apiVersion matches mobile expected version', async () => {
			const mockFetcher = async () =>
				new Response(JSON.stringify(versionBody()), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			const result = await checkMobileApiVersion({
				fetcher: mockFetcher,
				baseUrl: 'http://192.168.1.100:7817',
			});

			expect(result.compatible).toBe(true);
			if (result.compatible) {
				expect(result.apiVersion).toBe(CURRENT_API_VERSION);
				expect(result.daemonVersion).toBe('0.1.0');
				expect(result.nodeVersion).toBe('22.17.0');
			}
		});

		it('treats missing baseUrl as unreachable without guessing loopback', async () => {
			const result = await checkMobileApiVersion({
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

			const result = await checkMobileApiVersion({
				fetcher: mockFetcher,
				baseUrl: 'http://192.168.1.100:7817',
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

		it('AC 1 & E-14: handles network unreachable gracefully without throwing bottom-level errors', async () => {
			const mockFetcher = async () => {
				throw new Error('Network request failed');
			};

			const result = await checkMobileApiVersion({
				fetcher: mockFetcher,
				baseUrl: 'http://192.168.1.100:7817',
			});

			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('unreachable');
				expect(result.message).toContain('Unable to connect');
				expect(result.upgradePrompt).toContain('未能连接到电脑端调度服务');
			}
		});

		it('handles malformed non-JSON or non-200 responses gracefully', async () => {
			const mockFetcher500 = async () => new Response('Internal Server Error', { status: 500 });

			const result500 = await checkMobileApiVersion({
				fetcher: mockFetcher500,
				baseUrl: 'http://192.168.1.100:7817',
			});
			expect(result500.compatible).toBe(false);
			if (!result500.compatible) {
				expect(result500.reason).toBe('malformed');
			}

			const mockFetcherBadJson = async () =>
				new Response('{ bad json', {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			const resultBad = await checkMobileApiVersion({
				fetcher: mockFetcherBadJson,
				baseUrl: 'http://192.168.1.100:7817',
			});
			expect(resultBad.compatible).toBe(false);
			if (!resultBad.compatible) {
				expect(resultBad.reason).toBe('malformed');
			}
		});
	});

	describe('generateMobileUpgradeNotice', () => {
		it('returns structured notice for mobile UI banner or notification', () => {
			const notice = generateMobileUpgradeNotice({
				apiVersion: 'v2',
				expectedVersion: CURRENT_API_VERSION,
			});

			expect(notice.title).toBe('两端版本不一致');
			expect(notice.message).toContain('v2');
			expect(notice.message).toContain(CURRENT_API_VERSION);
			expect(notice.canContinue).toBe(false);
			expect(notice.serverVersion).toBe('v2');
			expect(notice.expectedVersion).toBe(CURRENT_API_VERSION);
		});
	});

	describe('initializeMobileShell version wiring (AC 1, E-14, R3)', () => {
		it('v2 response yields upgrade notice during initialize', async () => {
			const shell = initializeMobileShell({
				storageBackend: mockStorage,
				hostHint: () => 'http://192.168.1.50:7817',
				versionFetcher: async () =>
					new Response(JSON.stringify(versionBody({ apiVersion: 'v2' })), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
			});
			const result = await shell.versionCheckPromise;
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('incompatible');
			}
			expect(shell.upgradeNotice?.title).toBe('两端版本不一致');
			shell.destroy();
		});

		it('HTTP 500 is malformed, never thrown', async () => {
			const shell = initializeMobileShell({
				storageBackend: mockStorage,
				hostHint: () => 'http://192.168.1.50:7817',
				versionFetcher: async () => new Response('Internal Server Error', { status: 500 }),
			});
			const result = await shell.versionCheckPromise;
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('malformed');
			}
			shell.destroy();
		});

		it('network failure is unreachable without a reconnect loop', async () => {
			const shell = initializeMobileShell({
				storageBackend: mockStorage,
				hostHint: () => 'http://192.168.1.50:7817',
				versionFetcher: async () => {
					throw new Error('network down');
				},
			});
			const result = await shell.versionCheckPromise;
			expect(result.compatible).toBe(false);
			if (!result.compatible) {
				expect(result.reason).toBe('unreachable');
			}
			shell.destroy();
		});
	});
});
