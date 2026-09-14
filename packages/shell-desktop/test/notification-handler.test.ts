import { describe, expect, it, vi } from 'vitest';
import { deliverNotificationDeepLink } from '../src/notification-handler.ts';

describe('desktop notification-handler (AC 6)', () => {
	it('delivers deepLink to window.location.hash without custom IPC', () => {
		const mockWindow = {
			location: {
				hash: '',
			},
		};

		const success = deliverNotificationDeepLink('#/item/42', mockWindow);
		expect(success).toBe(true);
		expect(mockWindow.location.hash).toBe('#/item/42');
	});

	it('ensures leading # is attached if missing', () => {
		const mockWindow = {
			location: {
				hash: '',
			},
		};

		const success = deliverNotificationDeepLink('/item/42', mockWindow);
		expect(success).toBe(true);
		expect(mockWindow.location.hash).toBe('#/item/42');
	});

	it('uses window.eval when location object is not directly writable', () => {
		const evalMock = vi.fn();
		const mockWindow = {
			eval: evalMock,
		};

		const success = deliverNotificationDeepLink('#/test', mockWindow);
		expect(success).toBe(true);
		expect(evalMock).toHaveBeenCalledWith('window.location.hash = "#/test";');
	});

	it('returns false on empty or whitespace deepLink', () => {
		const mockWindow = {
			location: {
				hash: '',
			},
		};

		expect(deliverNotificationDeepLink('', mockWindow)).toBe(false);
		expect(deliverNotificationDeepLink('   ', mockWindow)).toBe(false);
	});
});
