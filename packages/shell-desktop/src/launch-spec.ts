import {
	type DaemonLaunchSpec,
	isAbsoluteLaunchPath,
	parseDaemonLaunchSpec,
} from '../../shared/src/shell/daemon-launch-spec.ts';

export interface ResolveLaunchSpecOptions {
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
	readonly hostPlatform?: string;
}

function normalizeAbsolutePath(rawPath: string): string {
	const cleaned = rawPath.trim();
	if (!cleaned || cleaned.includes('\0')) {
		return '';
	}
	return cleaned;
}

/**
 * Resolves and validates a frozen DaemonLaunchSpec based on actual current_exe and resource_dir.
 *
 * Requirements (AC 2, E-146, E-209):
 * - Resolves absolute file, args[], absolute cwd.
 * - Freezes the returned launch specification.
 * - Prohibits shell strings or relative paths.
 */
export function resolveLaunchSpec(options: ResolveLaunchSpecOptions): DaemonLaunchSpec {
	const currentExe = normalizeAbsolutePath(options.currentExe);
	const resourceDir = normalizeAbsolutePath(options.resourceDir);

	if (!isAbsoluteLaunchPath(currentExe)) {
		throw new Error('Desktop executable path must be absolute.');
	}
	if (!isAbsoluteLaunchPath(resourceDir)) {
		throw new Error('Desktop resource directory must be absolute.');
	}

	const platform =
		options.hostPlatform ?? (typeof process !== 'undefined' ? process.platform : 'win32');
	const isWindows = platform === 'win32';

	let daemonFile: string;
	if (options.customDaemonPath) {
		daemonFile = normalizeAbsolutePath(options.customDaemonPath);
	} else {
		const separator = isWindows ? '\\' : '/';
		const binaryName = isWindows ? 'daemon.exe' : 'daemon';
		const trimmedResource = resourceDir.endsWith(separator)
			? resourceDir.slice(0, -1)
			: resourceDir;
		daemonFile = `${trimmedResource}${separator}${binaryName}`;
	}

	const args = Object.freeze(options.customArguments ? [...options.customArguments] : []);
	const cwd = resourceDir;

	const candidate = {
		file: daemonFile,
		args,
		cwd,
	};

	const parseResult = parseDaemonLaunchSpec(candidate);
	if (!parseResult.ok) {
		const issueSummary = parseResult.issues
			.map((item) => `${item.path}: ${item.reason}`)
			.join(', ');
		throw new Error(`Invalid launch specification: ${issueSummary}`);
	}

	return parseResult.value;
}

/**
 * Compares two DaemonLaunchSpec objects field-by-field (file, args, cwd).
 * Used for idempotent native registration and detecting path changes (AC 4, E-209).
 */
export function areSpecsIdentical(left: DaemonLaunchSpec, right: DaemonLaunchSpec): boolean {
	if (left.file !== right.file || left.cwd !== right.cwd) {
		return false;
	}
	if (left.args.length !== right.args.length) {
		return false;
	}
	for (let i = 0; i < left.args.length; i++) {
		if (left.args[i] !== right.args[i]) {
			return false;
		}
	}
	return true;
}
