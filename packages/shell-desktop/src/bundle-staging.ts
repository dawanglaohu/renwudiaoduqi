import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { InstalledProductLayout } from './artifact-staging.ts';
import { DAEMON_ENTRY_FILE_NAME, resolveShippedDaemonLayout } from './launch-spec.ts';

export interface StageTauriBundleOptions {
	readonly bundlePath: string;
	readonly rootDir: string;
	readonly hostPlatform: 'win32' | 'darwin' | 'linux';
	readonly folderName?: string;
}

function executeCommand(command: string, args: readonly string[]): void {
	const result = spawnSync(command, [...args], { stdio: 'inherit', shell: false });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Bundle extraction command failed (${command} ${args.join(' ')}): ${result.status}`,
		);
	}
}

function findFile(root: string, predicate: (name: string, path: string) => boolean): string | null {
	if (!existsSync(root)) return null;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isFile() && predicate(entry.name, path)) return path;
		if (entry.isDirectory()) {
			const nested = findFile(path, predicate);
			if (nested) return nested;
		}
	}
	return null;
}

function extractBundle(bundlePath: string, outputDir: string, platform: string): void {
	const extension = bundlePath.toLowerCase();
	if (extension.endsWith('.msi')) {
		if (platform !== 'win32') throw new Error('An MSI bundle can only be expanded on Windows.');
		// Keep the administrative extraction path ASCII. The smoke runs the
		// extracted product from outputDir, which exercises the Unicode runtime path.
		const adminDir = join(dirname(outputDir), 'msi-admin-image');
		const logPath = join(dirname(outputDir), 'msi-extraction.log');
		mkdirSync(adminDir, { recursive: true });
		const args = [
			'/a',
			resolve(bundlePath),
			'/qn',
			'/norestart',
			`TARGETDIR=${resolve(adminDir)}`,
			'/L*V',
			logPath,
		];
		const result = spawnSync('msiexec.exe', args, {
			stdio: 'inherit',
			shell: false,
			timeout: 5 * 60_000,
		});
		if (result.error || result.status !== 0) {
			const logTail = existsSync(logPath)
				? readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-30).join('\n')
				: '(Windows Installer did not create a log)';
			throw new Error(
				`MSI expansion failed (${result.error?.message ?? `exit ${result.status}`}):\n${logTail}`,
			);
		}
		cpSync(adminDir, outputDir, { recursive: true, force: true });
		return;
	}

	if (extension.endsWith('.dmg')) {
		if (platform !== 'darwin') throw new Error('A DMG bundle can only be expanded on macOS.');
		const mountDir = `${outputDir}.mounted`;
		mkdirSync(mountDir, { recursive: true });
		try {
			executeCommand('hdiutil', [
				'attach',
				resolve(bundlePath),
				'-readonly',
				'-nobrowse',
				'-mountpoint',
				mountDir,
			]);
			cpSync(mountDir, outputDir, { recursive: true, force: true });
		} finally {
			spawnSync('hdiutil', ['detach', mountDir, '-force'], { stdio: 'ignore', shell: false });
		}
		return;
	}

	if (extension.endsWith('.deb')) {
		if (platform !== 'linux') throw new Error('A deb bundle can only be expanded on Linux.');
		executeCommand('dpkg-deb', ['--extract', resolve(bundlePath), resolve(outputDir)]);
		return;
	}

	throw new Error(`Unsupported Tauri bundle for staged smoke: ${bundlePath}`);
}

function findInstalledLayout(
	stageDir: string,
	platform: 'win32' | 'darwin' | 'linux',
): InstalledProductLayout {
	const daemonEntry = findFile(
		stageDir,
		(name, path) => name === DAEMON_ENTRY_FILE_NAME && basename(dirname(path)) === 'daemon-runtime',
	);
	if (!daemonEntry) {
		throw new Error(`Expanded bundle does not contain ${DAEMON_ENTRY_FILE_NAME}.`);
	}

	const daemonDir = resolve(daemonEntry, '..');
	const resourceDir = resolve(daemonDir, '..');
	const currentExe = findFile(stageDir, (name, path) => {
		if (platform === 'win32') return name.toLowerCase() === 'desktop-shell.exe';
		if (platform === 'darwin') return name === 'desktop-shell' && path.includes('/Contents/MacOS/');
		return name === 'desktop-shell';
	});
	if (!currentExe)
		throw new Error('Expanded bundle does not contain the desktop-shell executable.');

	const shipped = resolveShippedDaemonLayout(resourceDir, platform);
	const webDistDir = join(resourceDir, 'web', 'dist');
	if (!existsSync(shipped.runtimeExecutable) || !existsSync(shipped.daemonEntry)) {
		throw new Error(
			`Expanded bundle has an unexpected daemon layout: resourceDir=${resourceDir} runtime=${shipped.runtimeExecutable}`,
		);
	}

	return Object.freeze({
		stageDir,
		currentExe,
		resourceDir,
		daemonDir,
		runtimeExecutable: shipped.runtimeExecutable,
		daemonEntry: shipped.daemonEntry,
		webDistDir,
	});
}

/**
 * Expands a real Tauri installer into a path containing spaces and Unicode, then derives the
 * installed launch layout from the files on disk. Windows MSI, macOS DMG and Linux deb are the
 * smoke inputs; the same bundle directories are uploaded for release verification.
 */
export function stageTauriBundle(options: StageTauriBundleOptions): InstalledProductLayout {
	if (!existsSync(options.bundlePath)) {
		throw new Error(`Tauri bundle does not exist: ${options.bundlePath}`);
	}
	const stageDir = resolve(
		options.rootDir,
		options.folderName ?? '调度服务 桌面产物 (Unicode & Spaces) 1.0.0',
	);
	mkdirSync(stageDir, { recursive: true });
	extractBundle(options.bundlePath, stageDir, options.hostPlatform);
	return findInstalledLayout(stageDir, options.hostPlatform);
}
