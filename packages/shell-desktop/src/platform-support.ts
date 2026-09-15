export type DesktopPlatform = 'win32' | 'darwin' | 'linux';

export const REQUIRED_DESKTOP_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux'] as const);

export type PlatformArchitecture = 'x64' | 'arm64';

export interface ArchitectureSupportEntry {
	readonly platform: DesktopPlatform;
	readonly arch: PlatformArchitecture;
	readonly covered: boolean;
	readonly status: '支持' | '未覆盖';
	readonly baseline: string;
	readonly assetPattern: string | null;
	readonly note?: string;
}

export const PLATFORM_ARCHITECTURE_MATRIX: readonly ArchitectureSupportEntry[] = Object.freeze([
	{
		platform: 'win32',
		arch: 'x64',
		covered: true,
		status: '支持',
		baseline: 'Windows 10 / 11 (x64)',
		assetPattern: 'agsched-desktop_x64-setup.exe',
	},
	{
		platform: 'win32',
		arch: 'arm64',
		covered: false,
		status: '未覆盖',
		baseline: 'Windows 11 (ARM64)',
		assetPattern: null,
		note: 'Windows arm64 is uncovered; downloads must not provide mismatched architecture packages (E-259).',
	},
	{
		platform: 'darwin',
		arch: 'arm64',
		covered: true,
		status: '支持',
		baseline: 'macOS 11+ (Apple Silicon)',
		assetPattern: 'agsched-desktop_aarch64.dmg',
	},
	{
		platform: 'darwin',
		arch: 'x64',
		covered: true,
		status: '支持',
		baseline: 'macOS 11+ (Intel)',
		assetPattern: 'agsched-desktop_x64.dmg',
	},
	{
		platform: 'linux',
		arch: 'x64',
		covered: true,
		status: '支持',
		baseline: 'Ubuntu 22.04 LTS (x64, WebKitGTK 4.1/4.0 + GTK3)',
		assetPattern: 'agsched-desktop_amd64.deb',
	},
	{
		platform: 'linux',
		arch: 'arm64',
		covered: false,
		status: '未覆盖',
		baseline: 'Linux (ARM64)',
		assetPattern: null,
		note: 'Linux arm64 is uncovered; downloads must not provide mismatched architecture packages (E-259).',
	},
]);

export interface ResolveAssetOptions {
	readonly platform: DesktopPlatform;
	readonly arch: PlatformArchitecture;
	readonly isSigned?: boolean;
	readonly isNotarized?: boolean;
	readonly isFormalRelease?: boolean;
}

export interface ResolvedAssetResult {
	readonly covered: boolean;
	readonly status: string;
	readonly assetName: string | null;
	readonly isBuildVerificationOnly: boolean;
	readonly error?: string;
}

/**
 * Resolves desktop asset for a platform and architecture, enforcing architecture
 * coverage and macOS signing policies (AC 5, AC 6, E-259, E-267).
 */
export function resolvePlatformAsset(options: ResolveAssetOptions): ResolvedAssetResult {
	const entry = PLATFORM_ARCHITECTURE_MATRIX.find(
		(item) => item.platform === options.platform && item.arch === options.arch,
	);

	if (!entry || !entry.covered) {
		return Object.freeze({
			covered: false,
			status: '未覆盖',
			assetName: null,
			isBuildVerificationOnly: false,
			error: `Architecture ${options.arch} on ${options.platform} is uncovered (E-259). Mismatched architecture packages are rejected.`,
		});
	}

	// macOS signing validation (AC 6, E-267)
	if (options.platform === 'darwin') {
		const isSigned = options.isSigned ?? false;
		const isNotarized = options.isNotarized ?? false;
		const isFormal = options.isFormalRelease ?? false;

		if (!isSigned || !isNotarized) {
			if (isFormal) {
				throw new Error(
					'Formal release blocked (E-267): macOS release asset is not signed and notarized. Unsigned builds may only be published as build verification artifacts (构建验证件).',
				);
			}
			return Object.freeze({
				covered: true,
				status: '构建验证件',
				assetName: 'agsched-desktop_macos-build-verification.zip',
				isBuildVerificationOnly: true,
			});
		}
	}

	return Object.freeze({
		covered: true,
		status: '支持',
		assetName: entry.assetPattern,
		isBuildVerificationOnly: false,
	});
}

export type LinuxDistroTier = 'verified' | 'best-effort';

export interface LinuxDistroSupport {
	readonly distro: string;
	readonly tier: LinuxDistroTier;
	readonly label: string;
	readonly isVerifiedBaseline: boolean;
	readonly guide: string;
}

/**
 * Classifies Linux distribution into verified baseline vs best-effort compatibility (AC 7, E-258, E-268).
 */
export function classifyLinuxDistro(distroId: string): LinuxDistroSupport {
	const normalized = (distroId || '').toLowerCase().trim();
	if (normalized.includes('ubuntu')) {
		return Object.freeze({
			distro: 'ubuntu',
			tier: 'verified',
			label: '已验证基线',
			isVerifiedBaseline: true,
			guide:
				'Ubuntu 22.04 LTS and 24.04 LTS with WebKitGTK 4.1/4.0 and GTK3 is the verified CI baseline (E-258, E-268).',
		});
	}

	return Object.freeze({
		distro: normalized || 'generic-linux',
		tier: 'best-effort',
		label: '尽力兼容',
		isVerifiedBaseline: false,
		guide:
			'Distribution is supported on a best-effort basis (E-268). Ubuntu LTS is the official verified baseline.',
	});
}

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

export interface HostVerificationResult {
	readonly platform: DesktopPlatform;
	readonly hostLabel: string;
	readonly workspaceCheckPassed: boolean;
	readonly platformTestsPassed: boolean;
	readonly smokePassed: boolean;
	readonly shellBuildPassed: boolean;
	readonly isSigned?: boolean;
	readonly isNotarized?: boolean;
	readonly failureReason?: string;
}

/**
 * Asserts all three platform runners succeed across all four required verification steps (AC 1, AC 6, E-265, E-267).
 * Any platform failure blocks the entire release.
 */
export function assertReleaseVerification(
	results: readonly HostVerificationResult[],
	options?: { isFormalRelease?: boolean },
): void {
	const resultMap = new Map<DesktopPlatform, HostVerificationResult>();
	for (const r of results) {
		resultMap.set(r.platform, r);
	}

	const missingHosts: string[] = [];
	const failedSteps: string[] = [];

	for (const requiredPlatform of REQUIRED_DESKTOP_PLATFORMS) {
		const result = resultMap.get(requiredPlatform);
		if (!result) {
			missingHosts.push(requiredPlatform);
			continue;
		}

		const stepsFailed: string[] = [];
		if (!result.workspaceCheckPassed) stepsFailed.push('workspace-check');
		if (!result.platformTestsPassed) stepsFailed.push('platform-tests');
		if (!result.smokePassed) stepsFailed.push('daemon-smoke');
		if (!result.shellBuildPassed) stepsFailed.push('shell-build');

		if (stepsFailed.length > 0) {
			failedSteps.push(
				`${requiredPlatform} (${stepsFailed.join(', ')}${result.failureReason ? `: ${result.failureReason}` : ''})`,
			);
		}
	}

	if (missingHosts.length > 0 || failedSteps.length > 0) {
		const details = [
			missingHosts.length > 0 ? `Missing platform hosts: ${missingHosts.join(', ')}` : '',
			failedSteps.length > 0 ? `Failed host steps: ${failedSteps.join('; ')}` : '',
		]
			.filter(Boolean)
			.join('. ');
		throw new Error(
			`Three-platform matrix verification failed (E-265): all three platforms (Windows, macOS, Ubuntu) must pass check, tests, smoke, and build. ${details}`,
		);
	}

	// Formal release barrier for macOS signing (AC 6, E-267)
	if (options?.isFormalRelease) {
		const macResult = resultMap.get('darwin');
		if (macResult && (!macResult.isSigned || !macResult.isNotarized)) {
			throw new Error(
				'Formal release blocked (E-267): macOS artifacts are not signed and notarized.',
			);
		}
	}
}

export interface BaselineSyncInput {
	readonly packageJsonContent: string;
	readonly cargoTomlContent: string;
	readonly ciWorkflowContent: string;
	readonly platformDocContent: string;
}

export interface BaselineSyncReport {
	readonly synchronized: boolean;
	readonly issues: readonly string[];
}

/**
 * Validates that Node.js 22 LTS and Tauri v2 baselines are synchronized across
 * package.json, Cargo.toml, CI workflow, and platform documentation (AC 8, E-260).
 */
export function validateUpstreamBaselineSync(input: BaselineSyncInput): BaselineSyncReport {
	const issues: string[] = [];

	// 1. Node.js >= 22 requirement in package.json
	if (!input.packageJsonContent.includes('"node": ">=22"')) {
		issues.push('package.json must specify engines.node >= 22');
	}

	// 2. Node 22 in CI workflow
	if (
		!input.ciWorkflowContent.includes('node-version: 22') &&
		!input.ciWorkflowContent.includes('node-version: "22"') &&
		!input.ciWorkflowContent.includes("node-version: '22'")
	) {
		issues.push('CI workflow must configure Node.js version 22');
	}

	// 3. Node 22 mentioned in platform-support.md
	if (
		!input.platformDocContent.includes('Node.js 22') &&
		!input.platformDocContent.includes('Node 22')
	) {
		issues.push('docs/platform-support.md must document Node.js 22 LTS baseline');
	}

	// 4. Tauri v2 in Cargo.toml
	if (
		!input.cargoTomlContent.includes('tauri = { version = "2"') &&
		!input.cargoTomlContent.includes('tauri = "2"')
	) {
		issues.push('Cargo.toml must reference Tauri v2');
	}

	// 5. Tauri v2 in platform-support.md
	if (
		!input.platformDocContent.includes('Tauri v2') &&
		!input.platformDocContent.includes('Tauri 2')
	) {
		issues.push('docs/platform-support.md must document Tauri v2 baseline');
	}

	// 6. Three platforms in CI workflow
	const hasWindowsRunner = input.ciWorkflowContent.includes('windows-latest');
	const hasMacosRunner = input.ciWorkflowContent.includes('macos-latest');
	const hasUbuntuRunner = input.ciWorkflowContent.includes('ubuntu-latest');
	if (!hasWindowsRunner || !hasMacosRunner || !hasUbuntuRunner) {
		issues.push('CI workflow must contain windows-latest, macos-latest, and ubuntu-latest matrix');
	}

	// 7. Three platforms in platform-support.md
	const hasWindowsDoc =
		input.platformDocContent.includes('Windows 10/11') ||
		input.platformDocContent.includes('Windows 10');
	const hasMacosDoc =
		input.platformDocContent.includes('macOS 11+') || input.platformDocContent.includes('macOS 11');
	const hasLinuxDoc =
		input.platformDocContent.includes('Ubuntu 22.04') ||
		input.platformDocContent.includes('Ubuntu');
	if (!hasWindowsDoc || !hasMacosDoc || !hasLinuxDoc) {
		issues.push(
			'docs/platform-support.md must document Windows 10/11, macOS 11+, and Ubuntu baselines',
		);
	}

	return Object.freeze({
		synchronized: issues.length === 0,
		issues: Object.freeze(issues),
	});
}

/**
 * Asserts upstream baseline synchronization, throwing an Error when incomplete (AC 8, E-260).
 */
export function assertUpstreamBaselineSync(input: BaselineSyncInput): void {
	const report = validateUpstreamBaselineSync(input);
	if (!report.synchronized) {
		throw new Error(
			`Upstream platform baseline synchronization failed (E-260): ${report.issues.join('; ')}`,
		);
	}
}
