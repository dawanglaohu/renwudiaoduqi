import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AndroidEnvironmentInspection {
	readonly hasSdk: boolean;
	readonly hasJavaHome: boolean;
	readonly hasGradleWrapper: boolean;
	readonly missingPrerequisites: readonly string[];
	readonly isAvailable: boolean;
}

export interface BrowserFallbackDescriptor {
	readonly mode: 'browser-fallback';
	readonly fallbackUrl: string;
	readonly acceptanceCriteriaStatus: 'unchanged';
	readonly reason: string;
	readonly guidance: string;
}

export interface DetectAndroidEnvironmentOptions {
	readonly env?: Record<string, string | undefined>;
	readonly projectRoot?: string;
	readonly host?: string;
	readonly port?: number;
}

/**
 * Detects whether Android build environment is present (AC 6, E-200).
 * If Android SDK or build tools are missing, gracefully guides to opening
 * the scheduler LAN URL in any browser with identical acceptance criteria.
 */
export function detectAndroidBuildEnvironment(options: DetectAndroidEnvironmentOptions = {}): {
	readonly inspection: AndroidEnvironmentInspection;
	readonly fallback: BrowserFallbackDescriptor;
} {
	const currentEnv = options.env ?? {};

	const androidHome = currentEnv.ANDROID_HOME || currentEnv.ANDROID_SDK_ROOT;
	const hasSdk = Boolean(androidHome && androidHome.trim().length > 0);
	const hasJavaHome = Boolean(currentEnv.JAVA_HOME && currentEnv.JAVA_HOME.trim().length > 0);

	let hasGradleWrapper = false;
	if (options.projectRoot) {
		const gradlewPath = join(options.projectRoot, 'gradlew');
		const gradlewBatPath = join(options.projectRoot, 'gradlew.bat');
		hasGradleWrapper = existsSync(gradlewPath) || existsSync(gradlewBatPath);
	} else {
		hasGradleWrapper = true;
	}

	const missingPrerequisites: string[] = [];
	if (!hasSdk) missingPrerequisites.push('ANDROID_HOME / ANDROID_SDK_ROOT');
	if (!hasJavaHome) missingPrerequisites.push('JAVA_HOME');

	const isAvailable = hasSdk && hasJavaHome && hasGradleWrapper;

	const host = options.host ?? 'localhost';
	const port = options.port ?? 7817;
	const fallbackUrl = `http://${host}:${port}`;

	const fallback: BrowserFallbackDescriptor = Object.freeze({
		mode: 'browser-fallback',
		fallbackUrl,
		acceptanceCriteriaStatus: 'unchanged',
		reason: isAvailable
			? 'Android build environment is configured and ready.'
			: `Android build prerequisites missing: ${missingPrerequisites.join(', ')}.`,
		guidance:
			'When Android build environment is unavailable, open the daemon LAN URL directly in any mobile or desktop browser. The web client functionality and acceptance criteria remain identical and unaffected (E-200).',
	});

	const inspection: AndroidEnvironmentInspection = Object.freeze({
		hasSdk,
		hasJavaHome,
		hasGradleWrapper,
		missingPrerequisites: Object.freeze([...missingPrerequisites]),
		isAvailable,
	});

	return Object.freeze({ inspection, fallback });
}
