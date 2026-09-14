import { existsSync } from 'node:fs';

export interface WindowsWebView2Result {
	readonly isInstalled: boolean;
	readonly downloadUrl?: string;
	readonly guide?: string;
}

export interface LinuxDependenciesResult {
	readonly isSatisfied: boolean;
	readonly missing: readonly string[];
	readonly distro: string;
	readonly installCommand: string;
	readonly guide: string;
}

export interface MacosWebKitResult {
	readonly isSupported: boolean;
	readonly osVersion: string;
	readonly minimumRequired: string;
	readonly message?: string;
}

export interface PlatformDiagnosticsResult {
	readonly platform: 'win32' | 'darwin' | 'linux' | 'unsupported';
	readonly isHealthy: boolean;
	readonly details:
		| WindowsWebView2Result
		| LinuxDependenciesResult
		| MacosWebKitResult
		| { readonly message: string };
}

export const WEBVIEW2_DOWNLOAD_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

export const MINIMUM_MACOS_VERSION = '11.0.0';

export interface DiagnosticsInjection {
	readonly fileExists?: (path: string) => boolean;
	readonly checkRegistry?: () => boolean;
	readonly checkLibrary?: (libName: string) => boolean;
	readonly osVersion?: string;
	readonly distroId?: string;
}

/**
 * Windows WebView2 runtime detection and installation guide (AC 3, E-148).
 * Ensures absence of runtime provides installation guidance instead of white screen.
 */
export function checkWindowsWebView2(injection?: DiagnosticsInjection): WindowsWebView2Result {
	const registryOk = injection?.checkRegistry ? injection.checkRegistry() : false;
	const fileChecker = injection?.fileExists ?? existsSync;

	// Default candidate paths for Edge WebView2 Runtime on Windows
	const candidates = [
		'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application',
		'C:\\Program Files\\Microsoft\\EdgeWebView\\Application',
		'C:\\Windows\\SystemApps\\Microsoft.Win32WebViewHost_cw5n1h2txyewy',
	];

	const foundInFilesystem = candidates.some((candidate) => fileChecker(candidate));
	const isInstalled = registryOk || foundInFilesystem;

	if (isInstalled) {
		return Object.freeze({ isInstalled: true });
	}

	const guide = [
		'Microsoft Edge WebView2 Runtime is required to launch the desktop application.',
		'Please download and install the Evergreen Bootstrapper from:',
		`  ${WEBVIEW2_DOWNLOAD_URL}`,
		'After installation completes, restart the application.',
	].join('\n');

	return Object.freeze({
		isInstalled: false,
		downloadUrl: WEBVIEW2_DOWNLOAD_URL,
		guide,
	});
}

/**
 * Linux WebKitGTK and GTK dependency diagnosis (AC 3, E-258).
 * Runs before WebView creation to output package manager instructions on terminal.
 */
export function checkLinuxDependencies(injection?: DiagnosticsInjection): LinuxDependenciesResult {
	const distro = (injection?.distroId ?? 'ubuntu').toLowerCase();
	const checkLibrary = injection?.checkLibrary;
	const fileChecker = injection?.fileExists ?? existsSync;

	const standardLibPaths = [
		'/usr/lib/x86_64-linux-gnu',
		'/usr/lib64',
		'/usr/lib',
		'/lib/x86_64-linux-gnu',
		'/lib64',
		'/lib',
	];

	function probeLibrary(libNamePrefix: string): boolean {
		if (checkLibrary) {
			return checkLibrary(libNamePrefix);
		}
		for (const base of standardLibPaths) {
			if (fileChecker(`${base}/${libNamePrefix}`)) {
				return true;
			}
		}
		return false;
	}

	const hasWebKit =
		probeLibrary('libwebkit2gtk-4.1.so') ||
		probeLibrary('libwebkit2gtk-4.1.so.0') ||
		probeLibrary('libwebkit2gtk-4.0.so') ||
		probeLibrary('libwebkit2gtk-4.0.so.37');

	const hasGtk = probeLibrary('libgtk-3.so') || probeLibrary('libgtk-3.so.0');

	const missing: string[] = [];
	if (!hasWebKit) missing.push('webkit2gtk');
	if (!hasGtk) missing.push('gtk3');

	const isSatisfied = missing.length === 0;

	let installCommand = '';
	if (distro.includes('ubuntu') || distro.includes('debian')) {
		installCommand =
			'sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0';
	} else if (distro.includes('fedora') || distro.includes('rhel') || distro.includes('centos')) {
		installCommand = 'sudo dnf install -y webkit2gtk4.1 gtk3';
	} else if (distro.includes('arch') || distro.includes('manjaro')) {
		installCommand = 'sudo pacman -S --needed webkit2gtk-4.1 gtk3';
	} else if (distro.includes('suse')) {
		installCommand = 'sudo zypper install -y libwebkit2gtk-4_1-0 libgtk-3-0';
	} else {
		installCommand =
			'Install webkit2gtk (4.1 or 4.0) and gtk3 packages for your Linux distribution.';
	}

	const guide = isSatisfied
		? 'All desktop system libraries are satisfied.'
		: [
				`Missing required desktop system libraries: ${missing.join(', ')}.`,
				'To install on your distribution, execute:',
				`  ${installCommand}`,
				'Note: Desktop GUI cannot be initialized without these native libraries (E-258).',
			].join('\n');

	return Object.freeze({
		isSatisfied,
		missing: Object.freeze(missing),
		distro,
		installCommand,
		guide,
	});
}

/**
 * Parses semver string into [major, minor, patch] numeric tuple.
 */
function parseVersion(versionString: string): [number, number, number] {
	const parts = versionString.split('.').map((p) => Number.parseInt(p, 10) || 0);
	return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compares two version strings: returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(versionA: string, versionB: string): number {
	const [majorA, minorA, patchA] = parseVersion(versionA);
	const [majorB, minorB, patchB] = parseVersion(versionB);

	if (majorA !== majorB) return majorA > majorB ? 1 : -1;
	if (minorA !== minorB) return minorA > minorB ? 1 : -1;
	if (patchA !== patchB) return patchA > patchB ? 1 : -1;
	return 0;
}

/**
 * macOS system WebKit and OS minimum version check (AC 3, macOS 11+).
 */
export function checkMacosWebKit(injection?: DiagnosticsInjection): MacosWebKitResult {
	const osVersion = injection?.osVersion ?? '11.0.0';
	const isSupported = compareVersions(osVersion, MINIMUM_MACOS_VERSION) >= 0;

	return Object.freeze({
		isSupported,
		osVersion,
		minimumRequired: MINIMUM_MACOS_VERSION,
		message: isSupported
			? 'macOS WebKit runtime is available.'
			: `macOS version ${osVersion} is below minimum required baseline ${MINIMUM_MACOS_VERSION}.`,
	});
}

/**
 * Unified desktop platform runtime diagnostics (AC 3, E-148, E-258).
 */
export function diagnosePlatformRuntime(
	platform: string,
	injection?: DiagnosticsInjection,
): PlatformDiagnosticsResult {
	if (platform === 'win32') {
		const result = checkWindowsWebView2(injection);
		return Object.freeze({
			platform: 'win32',
			isHealthy: result.isInstalled,
			details: result,
		});
	}

	if (platform === 'linux') {
		const result = checkLinuxDependencies(injection);
		return Object.freeze({
			platform: 'linux',
			isHealthy: result.isSatisfied,
			details: result,
		});
	}

	if (platform === 'darwin') {
		const result = checkMacosWebKit(injection);
		return Object.freeze({
			platform: 'darwin',
			isHealthy: result.isSupported,
			details: result,
		});
	}

	return Object.freeze({
		platform: 'unsupported',
		isHealthy: false,
		details: Object.freeze({ message: `Unsupported desktop platform: ${platform}` }),
	});
}
