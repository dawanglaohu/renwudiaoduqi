import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { executeLinuxPrecheck, formatLinuxDependencyFailure } from '../launchers/linux-launcher.ts';
import { checkLinuxDependencies } from '../src/runtime-diagnostics.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

describe('M10-T5: Linux Launcher & Dependency Pre-flight Checking (AC 3, AC 7, E-258, E-268)', () => {
	it('AC 3 & E-258: formats accurate distribution-specific commands for Ubuntu, Fedora, Arch, openSUSE', () => {
		const ubuntuDetails = checkLinuxDependencies({
			distroId: 'ubuntu',
			checkLibrary: () => false,
		});
		const ubuntuOutput = formatLinuxDependencyFailure(ubuntuDetails);
		expect(ubuntuOutput).toContain(
			'sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0',
		);
		expect(ubuntuOutput).toContain('E-258');

		const fedoraDetails = checkLinuxDependencies({
			distroId: 'fedora',
			checkLibrary: () => false,
		});
		const fedoraOutput = formatLinuxDependencyFailure(fedoraDetails);
		expect(fedoraOutput).toContain('sudo dnf install -y webkit2gtk4.1 gtk3');

		const archDetails = checkLinuxDependencies({
			distroId: 'arch',
			checkLibrary: () => false,
		});
		const archOutput = formatLinuxDependencyFailure(archDetails);
		expect(archOutput).toContain('sudo pacman -S --needed webkit2gtk-4.1 gtk3');

		const suseDetails = checkLinuxDependencies({
			distroId: 'opensuse-tumbleweed',
			checkLibrary: () => false,
		});
		const suseOutput = formatLinuxDependencyFailure(suseDetails);
		expect(suseOutput).toContain('sudo zypper install -y libwebkit2gtk-4_1-0 libgtk-3-0');
	});

	it('AC 3 & E-258: executeLinuxPrecheck returns exitCode 1 and terminal guide when dependencies missing', () => {
		const result = executeLinuxPrecheck({
			injection: {
				distroId: 'ubuntu',
				checkLibrary: () => false,
			},
		});

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('[ERROR] Missing required desktop system libraries');
		expect(result.stderr).toContain('sudo apt-get install');
		expect(result.details.missing).toEqual(['webkit2gtk', 'gtk3']);
	});

	it('AC 3 & AC 7 & E-268: executeLinuxPrecheck returns exitCode 0 and adds best-effort notice for non-Ubuntu distros', () => {
		// Ubuntu baseline: passes cleanly without warning
		const ubuntuResult = executeLinuxPrecheck({
			injection: {
				distroId: 'ubuntu',
				checkLibrary: () => true,
			},
		});
		expect(ubuntuResult.ok).toBe(true);
		expect(ubuntuResult.exitCode).toBe(0);
		expect(ubuntuResult.stdout).toContain('[OK] Pre-flight dependency check passed');
		expect(ubuntuResult.stderr).toBe('');

		// Fedora: passes with best-effort compatibility notice (E-268)
		const fedoraResult = executeLinuxPrecheck({
			injection: {
				distroId: 'fedora',
				checkLibrary: () => true,
			},
		});
		expect(fedoraResult.ok).toBe(true);
		expect(fedoraResult.exitCode).toBe(0);
		expect(fedoraResult.stderr).toContain('E-268');
		expect(fedoraResult.stderr).toContain('supported on a best-effort basis');
	});

	it('AC 3 & E-258: tauri.conf.json bundle metadata declares WebKitGTK and GTK debian dependencies', () => {
		const tauriConfPath = resolve(repoRoot, 'packages/shell-desktop/src-tauri/tauri.conf.json');
		const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));

		const debDepends: string[] = conf.bundle?.linux?.deb?.depends ?? [];
		expect(debDepends).toBeDefined();
		expect(debDepends.some((d) => d.includes('libwebkit2gtk-4.1-0'))).toBe(true);
		expect(debDepends.some((d) => d.includes('libgtk-3-0'))).toBe(true);
	});

	it('AC 3: linux-launcher.sh shell script exists and contains dependency checks', () => {
		const scriptPath = resolve(repoRoot, 'packages/shell-desktop/launchers/linux-launcher.sh');
		expect(existsSync(scriptPath)).toBe(true);
		const content = readFileSync(scriptPath, 'utf8');

		expect(content).toContain('libwebkit2gtk-4.1.so*');
		expect(content).toContain('libgtk-3.so*');
		expect(content).toContain('E-258');
		expect(content).toContain('E-268');
	});
});
