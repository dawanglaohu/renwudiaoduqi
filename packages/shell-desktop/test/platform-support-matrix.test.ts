import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	PLATFORM_ARCHITECTURE_MATRIX,
	assertReleaseVerification,
	assertUpstreamBaselineSync,
	classifyLinuxDistro,
	resolvePlatformAsset,
	validateUpstreamBaselineSync,
} from '../src/platform-support.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

describe('M10-T5: Platform and Architecture Support Matrix (AC 1, AC 5-8, E-257, E-259, E-260, E-265, E-267, E-268)', () => {
	it('AC 2 & E-209: CI builds, unpacks, smokes, and uploads real Tauri installer bundles', () => {
		const ciWorkflowContent = readFileSync(
			resolve(repoRoot, '.github/workflows/desktop-ci.yml'),
			'utf8',
		);
		expect(ciWorkflowContent).toContain('tauri build --bundles');
		expect(ciWorkflowContent).toContain('--ci');
		expect(ciWorkflowContent).toContain('DESKTOP_BUNDLE_PATH');
		expect(ciWorkflowContent).toContain('target/release/bundle');
		expect(ciWorkflowContent).toContain('release-assets/agsched-desktop_x64-setup.exe');
		expect(ciWorkflowContent).toContain('release-assets/agsched-desktop_aarch64.dmg');
		expect(ciWorkflowContent).toContain('release-assets/agsched-desktop_amd64.deb');
		expect(ciWorkflowContent).toContain('APPLE_CERTIFICATE_PASSWORD');
		expect(ciWorkflowContent).toContain('APPLE_PASSWORD');
		expect(ciWorkflowContent).toContain('codesign --verify --deep --strict');
		expect(ciWorkflowContent).toContain('spctl --assess --type execute');
		expect(ciWorkflowContent).toContain('xcrun stapler validate');
		expect(ciWorkflowContent).not.toContain('Installer bundling (`tauri bundle`) is not run');
	});

	it('AC 5 & E-259: defines architecture matrix with Windows, macOS, Linux and marks arm64 uncovered on Windows/Linux', () => {
		const winX64 = PLATFORM_ARCHITECTURE_MATRIX.find(
			(e) => e.platform === 'win32' && e.arch === 'x64',
		);
		expect(winX64?.covered).toBe(true);
		expect(winX64?.status).toBe('支持');
		expect(winX64?.assetPattern).toBe('agsched-desktop_x64-setup.exe');

		const winArm = PLATFORM_ARCHITECTURE_MATRIX.find(
			(e) => e.platform === 'win32' && e.arch === 'arm64',
		);
		expect(winArm?.covered).toBe(false);
		expect(winArm?.status).toBe('未覆盖');
		expect(winArm?.assetPattern).toBeNull();

		const macArm = PLATFORM_ARCHITECTURE_MATRIX.find(
			(e) => e.platform === 'darwin' && e.arch === 'arm64',
		);
		expect(macArm?.covered).toBe(true);
		expect(macArm?.status).toBe('支持');
		expect(macArm?.assetPattern).toBe('agsched-desktop_aarch64.dmg');

		// The CI matrix has one macOS runner (Apple Silicon); Intel builds are not produced,
		// so the matrix must say so instead of offering the arm64 image (E-259).
		const macX64 = PLATFORM_ARCHITECTURE_MATRIX.find(
			(e) => e.platform === 'darwin' && e.arch === 'x64',
		);
		expect(macX64?.covered).toBe(false);
		expect(macX64?.status).toBe('未覆盖');
		expect(macX64?.assetPattern).toBeNull();
		expect(resolvePlatformAsset({ platform: 'darwin', arch: 'x64' }).assetName).toBeNull();

		const linuxX64 = PLATFORM_ARCHITECTURE_MATRIX.find(
			(e) => e.platform === 'linux' && e.arch === 'x64',
		);
		expect(linuxX64?.covered).toBe(true);
		expect(linuxX64?.status).toBe('支持');
		expect(linuxX64?.assetPattern).toBe('agsched-desktop_amd64.deb');

		const linuxArm = PLATFORM_ARCHITECTURE_MATRIX.find(
			(e) => e.platform === 'linux' && e.arch === 'arm64',
		);
		expect(linuxArm?.covered).toBe(false);
		expect(linuxArm?.status).toBe('未覆盖');
		expect(linuxArm?.assetPattern).toBeNull();
	});

	it('AC 5 & E-259: resolvePlatformAsset rejects uncovered architectures and does not provide wrong architecture package', () => {
		const winArmResult = resolvePlatformAsset({ platform: 'win32', arch: 'arm64' });
		expect(winArmResult.covered).toBe(false);
		expect(winArmResult.status).toBe('未覆盖');
		expect(winArmResult.assetName).toBeNull();
		expect(winArmResult.error).toContain('E-259');

		const linuxArmResult = resolvePlatformAsset({ platform: 'linux', arch: 'arm64' });
		expect(linuxArmResult.covered).toBe(false);
		expect(linuxArmResult.status).toBe('未覆盖');
		expect(linuxArmResult.assetName).toBeNull();

		const winX64Result = resolvePlatformAsset({ platform: 'win32', arch: 'x64' });
		expect(winX64Result.covered).toBe(true);
		expect(winX64Result.status).toBe('支持');
		expect(winX64Result.assetName).toBe('agsched-desktop_x64-setup.exe');
	});

	it('AC 6 & E-267: macOS unsigned artifacts are labeled 构建验证件 and blocked from formal release', () => {
		// Non-formal release: returns build verification artifact
		const unnotarized = resolvePlatformAsset({
			platform: 'darwin',
			arch: 'arm64',
			isSigned: false,
			isNotarized: false,
			isFormalRelease: false,
		});
		expect(unnotarized.status).toBe('构建验证件');
		expect(unnotarized.isBuildVerificationOnly).toBe(true);
		expect(unnotarized.assetName).toBe('agsched-desktop_macos-build-verification.zip');

		// Formal release: throws error to enforce release gate
		expect(() =>
			resolvePlatformAsset({
				platform: 'darwin',
				arch: 'arm64',
				isSigned: false,
				isNotarized: false,
				isFormalRelease: true,
			}),
		).toThrow(/Formal release blocked \(E-267\): macOS release asset is not signed and notarized/);

		// Signed and notarized: normal supported release
		const signedResult = resolvePlatformAsset({
			platform: 'darwin',
			arch: 'arm64',
			isSigned: true,
			isNotarized: true,
			isFormalRelease: true,
		});
		expect(signedResult.status).toBe('支持');
		expect(signedResult.isBuildVerificationOnly).toBe(false);
		expect(signedResult.assetName).toBe('agsched-desktop_aarch64.dmg');
	});

	it('AC 7 & E-258 & E-268: classifies Ubuntu as verified baseline and other distros as best-effort compatibility', () => {
		const ubuntu = classifyLinuxDistro('Ubuntu 22.04 LTS');
		expect(ubuntu.tier).toBe('verified');
		expect(ubuntu.isVerifiedBaseline).toBe(true);
		expect(ubuntu.label).toBe('已验证基线');

		const fedora = classifyLinuxDistro('fedora');
		expect(fedora.tier).toBe('best-effort');
		expect(fedora.isVerifiedBaseline).toBe(false);
		expect(fedora.label).toBe('尽力兼容');

		const arch = classifyLinuxDistro('arch');
		expect(arch.tier).toBe('best-effort');
		expect(arch.label).toBe('尽力兼容');
	});

	it('AC 1 & E-265: assertReleaseVerification requires all 3 platforms and blocks if any step fails', () => {
		const successfulMatrix = [
			{
				platform: 'win32' as const,
				hostLabel: 'windows-latest',
				workspaceCheckPassed: true,
				platformTestsPassed: true,
				smokePassed: true,
				shellBuildPassed: true,
			},
			{
				platform: 'darwin' as const,
				hostLabel: 'macos-latest',
				workspaceCheckPassed: true,
				platformTestsPassed: true,
				smokePassed: true,
				shellBuildPassed: true,
			},
			{
				platform: 'linux' as const,
				hostLabel: 'ubuntu-latest',
				workspaceCheckPassed: true,
				platformTestsPassed: true,
				smokePassed: true,
				shellBuildPassed: true,
			},
		];

		expect(() => assertReleaseVerification(successfulMatrix)).not.toThrow();

		const winRunner = successfulMatrix[0];
		const macRunner = successfulMatrix[1];
		const linuxRunner = successfulMatrix[2];
		if (!winRunner || !macRunner || !linuxRunner) {
			throw new Error('Test matrix fixture incomplete');
		}

		// Fails if Ubuntu fails smoke
		const failingUbuntu = [
			winRunner,
			macRunner,
			{
				...linuxRunner,
				smokePassed: false,
				failureReason: 'health check timed out',
			},
		];
		expect(() => assertReleaseVerification(failingUbuntu)).toThrow(
			/Three-platform matrix verification failed \(E-265\)/,
		);

		// Fails if a platform runner is missing
		const missingPlatform = [winRunner, macRunner];
		expect(() => assertReleaseVerification(missingPlatform)).toThrow(
			/Missing platform hosts: linux/,
		);

		// Formal release fails if macOS is unsigned (E-267)
		expect(() => assertReleaseVerification(successfulMatrix, { isFormalRelease: true })).toThrow(
			/Formal release blocked \(E-267\): macOS artifacts are not signed/,
		);
	});

	it('AC 8 & E-260: validateUpstreamBaselineSync succeeds on repository sources and detects missing baselines', () => {
		const packageJsonContent = readFileSync(resolve(repoRoot, 'package.json'), 'utf8');
		const cargoTomlContent = readFileSync(
			resolve(repoRoot, 'packages/shell-desktop/src-tauri/Cargo.toml'),
			'utf8',
		);
		const ciWorkflowContent = readFileSync(
			resolve(repoRoot, '.github/workflows/desktop-ci.yml'),
			'utf8',
		);
		const platformDocContent = readFileSync(resolve(repoRoot, 'docs/platform-support.md'), 'utf8');
		const daemonRuntimeManifestContent = readFileSync(
			resolve(repoRoot, 'packages/shell-desktop/daemon-runtime.json'),
			'utf8',
		);

		const report = validateUpstreamBaselineSync({
			packageJsonContent,
			cargoTomlContent,
			ciWorkflowContent,
			platformDocContent,
			daemonRuntimeManifestContent,
		});

		expect(report.synchronized).toBe(true);
		expect(report.issues).toEqual([]);
		expect(() =>
			assertUpstreamBaselineSync({
				packageJsonContent,
				cargoTomlContent,
				ciWorkflowContent,
				platformDocContent,
			}),
		).not.toThrow();

		// Fails if CI workflow lacks Node 22
		const badCiReport = validateUpstreamBaselineSync({
			packageJsonContent,
			cargoTomlContent,
			ciWorkflowContent: 'name: CI\nruns-on: ubuntu-latest\nnode-version: 18',
			platformDocContent,
		});
		expect(badCiReport.synchronized).toBe(false);
		expect(badCiReport.issues.some((i) => i.includes('Node.js version 22'))).toBe(true);

		// Fails if the shipped runtime is bumped without the docs following (E-260)
		const bumpedRuntime = validateUpstreamBaselineSync({
			packageJsonContent,
			cargoTomlContent,
			ciWorkflowContent,
			platformDocContent,
			daemonRuntimeManifestContent: JSON.stringify({ node: '22.99.0' }),
		});
		expect(bumpedRuntime.synchronized).toBe(false);
		expect(bumpedRuntime.issues.some((i) => i.includes('22.99.0'))).toBe(true);

		// Fails if the shipped runtime leaves the promised major
		const wrongMajor = validateUpstreamBaselineSync({
			packageJsonContent,
			cargoTomlContent,
			ciWorkflowContent,
			platformDocContent,
			daemonRuntimeManifestContent: JSON.stringify({ node: '24.1.0' }),
		});
		expect(wrongMajor.synchronized).toBe(false);
		expect(wrongMajor.issues.some((i) => i.includes('Node 22.x'))).toBe(true);
	});
});
