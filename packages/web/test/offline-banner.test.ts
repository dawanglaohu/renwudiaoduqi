/**
 * packages/web/test/offline-banner.test.tsx
 *
 * M9-T11: OfflineBanner component tests (AC 1-4, E-04, E-12, E-14, E-157)
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OfflineBanner, formatBannerLastSynced } from '../src/components/offline-banner.tsx';

describe('M9-T11: OfflineBanner presentation component (AC 1-4, E-04, E-12, E-14, E-157)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-157: 服务端事件到达即清 intent，失败则清 intent + 横幅回滚
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-157: Rollback notice banner', () => {
		it('renders rollback banner with clear message and dismiss control', () => {
			const onDismiss = vi.fn();
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'online',
					rollbackNotice: {
						runId: 'run-123',
						message: '你在第 3/5 步停止失败，已恢复原状态',
						timestamp: Date.now(),
					},
					onDismissRollback: onDismiss,
				}),
			);

			expect(html).toContain('data-banner-kind="rollback"');
			expect(html).toContain('data-testid="rollback-banner"');
			expect(html).toContain('你在第 3/5 步停止失败，已恢复原状态');
			expect(html).toContain('aria-label="关闭横幅"');
			expect(html).toContain('role="alert"');
		});

		it('gives rollback notice priority over offline state', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					isDaemonRunning: false,
					rollbackNotice: {
						runId: 'run-456',
						message: '中止任务失败，已恢复原状态',
					},
				}),
			);

			expect(html).toContain('data-banner-kind="rollback"');
			expect(html).toContain('中止任务失败，已恢复原状态');
			expect(html).not.toContain('电脑上的调度服务未启动');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-12: 断连时顶栏显示「离线，最后同步于 X」并禁用派发按钮，恢复后自动补拉
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-12: Offline state topbar banner', () => {
		it('renders 「离线，最后同步于 X」 with formatted timestamp when offline', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					lastSyncedAt: '14:25:30',
				}),
			);

			expect(html).toContain('data-banner-kind="offline"');
			expect(html).toContain('data-testid="offline-banner"');
			expect(html).toContain('离线，最后同步于');
			expect(html).toContain('14:25:30');
		});

		it('formats ISO date strings properly into HH:mm:ss', () => {
			const date = new Date('2026-09-16T12:34:56.000Z');
			const formatted = formatBannerLastSynced(date);
			expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}$/);

			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					lastSyncedAt: date,
				}),
			);

			expect(html).toContain('离线，最后同步于');
			expect(html).toContain(formatted);
		});

		it('handles null / undefined lastSyncedAt gracefully with em dash', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					lastSyncedAt: null,
				}),
			);

			expect(html).toContain('离线，最后同步于');
			expect(html).toContain('—');
		});

		it('renders retry connection button when onRetry callback is provided', () => {
			const onRetry = vi.fn();
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					onRetry,
				}),
			);

			expect(html).toContain('重试连接');
		});

		it('renders reconnecting state when status is reconnecting', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'reconnecting',
				}),
			);

			expect(html).toContain('data-banner-kind="reconnecting"');
			expect(html).toContain('data-testid="reconnecting-banner"');
			expect(html).toContain('正在重新连接调度服务...');
		});

		it('renders null when status is online and healthy', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'online',
					isDaemonRunning: true,
					isVersionCompatible: true,
				}),
			);

			expect(html).toBe('');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-04: daemon 未运行时明确提示「电脑上的调度服务未启动」，而不是连接超时
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-04: Daemon down notification', () => {
		it('renders 「电脑上的调度服务未启动」 and never contains "连接超时"', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					isDaemonRunning: false,
				}),
			);

			expect(html).toContain('data-banner-kind="daemon-down"');
			expect(html).toContain('data-testid="daemon-down-banner"');
			expect(html).toContain('电脑上的调度服务未启动');
			expect(html).not.toContain('连接超时');
			expect(html).not.toContain('网络超时');
			expect(html).not.toContain('ECONNREFUSED');
		});

		it('renders daemon down when daemonErrorReason is daemon_down', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'offline',
					isDaemonRunning: true,
					daemonErrorReason: 'daemon_down',
				}),
			);

			expect(html).toContain('data-banner-kind="daemon-down"');
			expect(html).toContain('电脑上的调度服务未启动');
			expect(html).not.toContain('连接超时');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & E-14: 版本不兼容时提示升级而不是抛底层错误
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-14: Version incompatibility prompt', () => {
		it('renders upgrade prompt without throwing errors', () => {
			let html = '';
			expect(() => {
				html = renderToStaticMarkup(
					createElement(OfflineBanner, {
						status: 'online',
						isVersionCompatible: false,
						versionInfo: {
							expected: 'v1',
							actual: 'v2',
						},
					}),
				);
			}).not.toThrow();

			expect(html).toContain('data-banner-kind="version-incompatible"');
			expect(html).toContain('data-testid="version-incompatible-banner"');
			expect(html).toContain('版本不兼容，请升级客户端应用');
			expect(html).toContain('v1');
			expect(html).toContain('v2');
		});

		it('renders upgrade prompt even without detailed version info', () => {
			const html = renderToStaticMarkup(
				createElement(OfflineBanner, {
					status: 'online',
					isVersionCompatible: false,
				}),
			);

			expect(html).toContain('版本不兼容，请升级客户端应用');
		});
	});
});
