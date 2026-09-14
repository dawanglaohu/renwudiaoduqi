import { describe, expect, it } from 'vitest';
import {
	REQUIRED_DESKTOP_PLATFORMS,
	assertFullPlatformSupport,
	evaluatePlatformSupport,
} from '../src/platform-support.ts';

describe('desktop platform-support (AC 1, E-257)', () => {
	it('requires Windows, macOS, and Linux in desktop platform matrix', () => {
		expect(REQUIRED_DESKTOP_PLATFORMS).toEqual(['win32', 'darwin', 'linux']);
	});

	it('evaluates fully supported when daemon, path adapter, and desktop shell are present', () => {
		const report = evaluatePlatformSupport('win32', {
			hasDaemonSupport: true,
			hasPathAdapter: true,
			hasDesktopShell: true,
		});

		expect(report.isFullySupported).toBe(true);
	});

	it('evaluates incomplete when desktop shell is missing (E-257)', () => {
		const report = evaluatePlatformSupport('linux', {
			hasDaemonSupport: true,
			hasPathAdapter: true,
			hasDesktopShell: false,
		});

		expect(report.isFullySupported).toBe(false);
	});

	it('assertFullPlatformSupport passes when all three platforms are complete', () => {
		const reports = [
			evaluatePlatformSupport('win32', {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
			}),
			evaluatePlatformSupport('darwin', {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
			}),
			evaluatePlatformSupport('linux', {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
			}),
		];

		expect(() => assertFullPlatformSupport(reports)).not.toThrow();
	});

	it('assertFullPlatformSupport fails when any platform lacks desktop shell', () => {
		const reports = [
			evaluatePlatformSupport('win32', {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
			}),
			evaluatePlatformSupport('darwin', {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: true,
			}),
			evaluatePlatformSupport('linux', {
				hasDaemonSupport: true,
				hasPathAdapter: true,
				hasDesktopShell: false,
			}),
		];

		expect(() => assertFullPlatformSupport(reports)).toThrow(
			/Desktop platform support is incomplete/,
		);
	});
});
