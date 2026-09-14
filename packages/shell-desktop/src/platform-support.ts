export type DesktopPlatform = 'win32' | 'darwin' | 'linux';

export const REQUIRED_DESKTOP_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux'] as const);

export interface PlatformProductLayers {
	readonly hasDaemonSupport: boolean;
	readonly hasPathAdapter: boolean;
	readonly hasDesktopShell: boolean;
}

export interface PlatformCoverageReport {
	readonly platform: DesktopPlatform;
	readonly layers: PlatformProductLayers;
	readonly isFullySupported: boolean;
}

export interface DesktopWindowFocusable {
	show(): void;
	unminimize(): void;
	setFocus(): void;
}

/**
 * Handles second instance activation args and brings existing window to focus (AC 1).
 */
export function handleSecondInstance(
	windowTarget?: DesktopWindowFocusable,
	_args?: readonly string[],
	_cwd?: string,
): boolean {
	if (!windowTarget) {
		return false;
	}
	windowTarget.show();
	windowTarget.unminimize();
	windowTarget.setFocus();
	return true;
}

/**
 * Validates product layer completeness for a desktop platform (AC 1, E-257).
 * A platform is fully supported if and only if daemon, platform adapters, and desktop shell are all present.
 */
export function evaluatePlatformSupport(
	platform: DesktopPlatform,
	layers: PlatformProductLayers,
): PlatformCoverageReport {
	const isFullySupported =
		layers.hasDaemonSupport && layers.hasPathAdapter && layers.hasDesktopShell;

	return Object.freeze({
		platform,
		layers: Object.freeze({ ...layers }),
		isFullySupported,
	});
}

/**
 * Asserts that all three required desktop platforms have full desktop shell support (E-257).
 * If any platform lacks desktop shell, release verification fails with missing layers listed.
 */
export function assertFullPlatformSupport(reports: readonly PlatformCoverageReport[]): void {
	const platformMap = new Map<DesktopPlatform, PlatformCoverageReport>();
	for (const rep of reports) {
		platformMap.set(rep.platform, rep);
	}

	const missingPlatforms: string[] = [];
	const incompletePlatforms: string[] = [];

	for (const reqPlatform of REQUIRED_DESKTOP_PLATFORMS) {
		const report = platformMap.get(reqPlatform);
		if (!report) {
			missingPlatforms.push(reqPlatform);
		} else if (!report.isFullySupported) {
			const missingLayers: string[] = [];
			if (!report.layers.hasDaemonSupport) missingLayers.push('daemon');
			if (!report.layers.hasPathAdapter) missingLayers.push('path-adapter');
			if (!report.layers.hasDesktopShell) missingLayers.push('desktop-shell');
			incompletePlatforms.push(`${reqPlatform} (missing: ${missingLayers.join(', ')})`);
		}
	}

	if (missingPlatforms.length > 0 || incompletePlatforms.length > 0) {
		const details = [
			missingPlatforms.length > 0 ? `Unreported platforms: ${missingPlatforms.join(', ')}` : '',
			incompletePlatforms.length > 0
				? `Incomplete platforms: ${incompletePlatforms.join('; ')}`
				: '',
		]
			.filter(Boolean)
			.join('. ');
		throw new Error(
			`Desktop platform support is incomplete (E-257): all three platforms (Windows, macOS, Linux) must provide full shell support. ${details}`,
		);
	}
}
