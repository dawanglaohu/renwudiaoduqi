import { describe, expect, it } from 'vitest';
import { detectAndroidBuildEnvironment } from '../src/android-env.ts';

describe('Android Environment Detection & Browser Fallback (AC 6, E-200)', () => {
	it('AC 6 & E-200: degrades gracefully to browser LAN URL when Android SDK is missing', () => {
		const { inspection, fallback } = detectAndroidBuildEnvironment({
			env: {
				ANDROID_HOME: '',
				ANDROID_SDK_ROOT: '',
				JAVA_HOME: '',
			},
			host: '192.168.1.100',
			port: 7817,
		});

		expect(inspection.isAvailable).toBe(false);
		expect(inspection.hasSdk).toBe(false);
		expect(inspection.missingPrerequisites).toContain('ANDROID_HOME / ANDROID_SDK_ROOT');

		// Fallback descriptor provides direct LAN URL
		expect(fallback.mode).toBe('browser-fallback');
		expect(fallback.fallbackUrl).toBe('http://192.168.1.100:7817');
		// Acceptance criteria remains unchanged per E-200
		expect(fallback.acceptanceCriteriaStatus).toBe('unchanged');
		expect(fallback.guidance).toContain('E-200');
	});

	it('detects available Android environment when prerequisites are met', () => {
		const { inspection, fallback } = detectAndroidBuildEnvironment({
			env: {
				ANDROID_HOME: '/opt/android-sdk',
				JAVA_HOME: '/opt/java',
			},
		});

		expect(inspection.isAvailable).toBe(true);
		expect(inspection.hasSdk).toBe(true);
		expect(inspection.hasJavaHome).toBe(true);
		expect(inspection.missingPrerequisites).toHaveLength(0);
		expect(fallback.reason).toContain('ready');
	});
});
