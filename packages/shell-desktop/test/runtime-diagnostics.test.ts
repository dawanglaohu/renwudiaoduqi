import { describe, expect, it } from 'vitest';
import {
	WEBVIEW2_DOWNLOAD_URL,
	checkLinuxDependencies,
	checkMacosWebKit,
	checkWindowsWebView2,
	diagnosePlatformRuntime,
} from '../src/runtime-diagnostics.ts';

describe('desktop runtime-diagnostics (AC 3, E-148, E-258)', () => {
	describe('Windows WebView2 (E-148)', () => {
		it('reports installed when registry check succeeds', () => {
			const result = checkWindowsWebView2({
				checkRegistry: () => true,
			});
			expect(result.isInstalled).toBe(true);
			expect(result.downloadUrl).toBeUndefined();
		});

		it('reports missing with download guide when not installed', () => {
			const result = checkWindowsWebView2({
				checkRegistry: () => false,
				fileExists: () => false,
			});
			expect(result.isInstalled).toBe(false);
			expect(result.downloadUrl).toBe(WEBVIEW2_DOWNLOAD_URL);
			expect(result.guide).toContain('Evergreen Bootstrapper');
		});
	});

	describe('Linux WebKitGTK/GTK (E-258)', () => {
		it('reports satisfied when libraries exist', () => {
			const result = checkLinuxDependencies({
				checkLibrary: () => true,
				distroId: 'ubuntu',
			});
			expect(result.isSatisfied).toBe(true);
			expect(result.missing).toEqual([]);
		});

		it('diagnoses missing libraries and generates Ubuntu apt command', () => {
			const result = checkLinuxDependencies({
				checkLibrary: () => false,
				distroId: 'ubuntu',
			});
			expect(result.isSatisfied).toBe(false);
			expect(result.missing).toEqual(['webkit2gtk', 'gtk3']);
			expect(result.installCommand).toContain('apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0');
			expect(result.guide).toContain('sudo apt-get');
		});

		it('diagnoses missing libraries and generates Fedora dnf command', () => {
			const result = checkLinuxDependencies({
				checkLibrary: () => false,
				distroId: 'fedora',
			});
			expect(result.isSatisfied).toBe(false);
			expect(result.installCommand).toContain('dnf install -y webkit2gtk4.1 gtk3');
		});

		it('diagnoses missing libraries and generates Arch pacman command', () => {
			const result = checkLinuxDependencies({
				checkLibrary: () => false,
				distroId: 'arch',
			});
			expect(result.isSatisfied).toBe(false);
			expect(result.installCommand).toContain('pacman -S --needed webkit2gtk-4.1 gtk3');
		});
	});

	describe('macOS WebKit', () => {
		it('accepts macOS 11.0.0 and above', () => {
			const result = checkMacosWebKit({ osVersion: '12.4.0' });
			expect(result.isSupported).toBe(true);
		});

		it('rejects versions below macOS 11.0.0', () => {
			const result = checkMacosWebKit({ osVersion: '10.15.7' });
			expect(result.isSupported).toBe(false);
			expect(result.message).toContain('below minimum required baseline 11.0.0');
		});
	});

	describe('diagnosePlatformRuntime', () => {
		it('dispatches to platform specific check', () => {
			const win = diagnosePlatformRuntime('win32', { checkRegistry: () => true });
			expect(win.platform).toBe('win32');
			expect(win.isHealthy).toBe(true);

			const unsupported = diagnosePlatformRuntime('freebsd');
			expect(unsupported.platform).toBe('unsupported');
			expect(unsupported.isHealthy).toBe(false);
		});
	});
});
