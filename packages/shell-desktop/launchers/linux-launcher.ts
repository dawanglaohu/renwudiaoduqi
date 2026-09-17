import {
	type DiagnosticsInjection,
	type LinuxDependenciesResult,
	checkLinuxDependencies,
} from '../src/runtime-diagnostics.ts';

export interface LinuxLauncherOutput {
	readonly ok: boolean;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly details: LinuxDependenciesResult;
}

export interface LinuxLauncherOptions {
	readonly injection?: DiagnosticsInjection;
	readonly executeBinary?: boolean;
	readonly binaryPath?: string;
}

/**
 * Formats a user-friendly error output for missing Linux WebKitGTK and GTK3 dependencies (AC 3, E-258).
 */
export function formatLinuxDependencyFailure(details: LinuxDependenciesResult): string {
	const header =
		'================================================================================\n' +
		'[ERROR] Missing required desktop system libraries for Desktop Shell (E-258)\n' +
		'================================================================================\n' +
		'The desktop GUI cannot initialize WebView without native WebKitGTK and GTK3.\n\n';

	const commandBlock = `To install the missing dependencies on ${details.distro}, execute:
  ${details.installCommand}

After installation completes, re-run this launcher.
================================================================================
`;

	return header + commandBlock;
}

/**
 * Executes Linux launcher pre-check before creating GUI (AC 3, E-258).
 * Checks WebKitGTK and GTK3; if missing, returns exit code 1 and install instructions.
 * If not on Ubuntu baseline, notes best-effort support (AC 7, E-268).
 */
export function executeLinuxPrecheck(options?: LinuxLauncherOptions): LinuxLauncherOutput {
	const details = checkLinuxDependencies(options?.injection);

	if (!details.isSatisfied) {
		const stderr = formatLinuxDependencyFailure(details);
		return Object.freeze({
			ok: false,
			exitCode: 1,
			stdout: '',
			stderr,
			details,
		});
	}

	const isUbuntu = details.distro.toLowerCase().includes('ubuntu');
	const stdout = '[OK] Pre-flight dependency check passed: WebKitGTK and GTK3 are available.\n';
	let stderr = '';

	if (!isUbuntu) {
		stderr = `[NOTE] Desktop shell verified baseline is Ubuntu LTS (E-268).
       Distribution '${details.distro}' is supported on a best-effort basis.
`;
	}

	return Object.freeze({
		ok: true,
		exitCode: 0,
		stdout,
		stderr,
		details,
	});
}
