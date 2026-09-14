import { describe, expect, it, vi } from 'vitest';
import {
	MOBILE_AUTOSTART_SUPPORTED,
	getMobileAutostartStatus,
	skipMobileAutostartRegistration,
} from '../src/autostart.ts';

describe('Mobile Autostart Suppression (AC 5, E-211)', () => {
	it('AC 5 & E-211: mobile autostart is unsupported and generates zero warnings, zero alerts, zero UI disturbances', () => {
		expect(MOBILE_AUTOSTART_SUPPORTED).toBe(false);

		const status = getMobileAutostartStatus();
		expect(status.isSupported).toBe(false);
		expect(status.isRegistered).toBe(false);
		expect(status.hasWarningOrUi).toBe(false);
		expect(status.suppressed).toBe(true);
	});

	it('E-211: skipping mobile autostart registration emits NO log warnings or errors', () => {
		const mockLogger = {
			warn: vi.fn(),
			error: vi.fn(),
		};

		const status = skipMobileAutostartRegistration(mockLogger);

		expect(status.hasWarningOrUi).toBe(false);
		expect(mockLogger.warn).not.toHaveBeenCalled();
		expect(mockLogger.error).not.toHaveBeenCalled();
	});
});
