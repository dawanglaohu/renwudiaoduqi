import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	BUNDLED_RUNTIME_DIR_NAME,
	DAEMON_ENTRY_FILE_NAME,
	DAEMON_RUNTIME_DIR_NAME,
	resolveShippedDaemonLayout,
} from '../src/launch-spec.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Guards the Rust startup path (AC 2, E-209):
 * the frozen DaemonLaunchSpec must be resolved from an absolute resource directory and
 * validated before it is handed to launch_service. A relative fallback would make the
 * daemon launch depend on the caller's working directory.
 */
describe('desktop startup launch spec resolution (AC 2, E-146, E-209)', () => {
	const libRsPath = join(__dirname, '../src-tauri/src/lib.rs');

	it('validates absolute paths instead of falling back to a relative resource directory', () => {
		const libRs = readFileSync(libRsPath, 'utf8');

		expect(libRs).toContain('is_absolute_launch_path');
		expect(libRs).toContain('must be an absolute path');
		expect(libRs).not.toContain('PathBuf::from(".")');
	});

	it('derives the same shipped daemon layout as the TypeScript resolver (E-209)', () => {
		// Both sides start `<resource_dir>/daemon-runtime/runtime/node[.exe]` with
		// `<resource_dir>/daemon-runtime/bootstrap.mjs`; a layout change on one side only
		// would make the button and the autostart entry point at a file that is not there.
		const libRs = readFileSync(libRsPath, 'utf8');
		expect(libRs).toContain(`const DAEMON_RUNTIME_DIR_NAME: &str = "${DAEMON_RUNTIME_DIR_NAME}";`);
		expect(libRs).toContain(
			`const BUNDLED_RUNTIME_DIR_NAME: &str = "${BUNDLED_RUNTIME_DIR_NAME}";`,
		);
		expect(libRs).toContain(`const DAEMON_ENTRY_FILE_NAME: &str = "${DAEMON_ENTRY_FILE_NAME}";`);
		expect(libRs).toContain('args: vec![daemon_entry_text]');
		expect(libRs).not.toContain('"daemon.exe"');

		const layout = resolveShippedDaemonLayout('/opt/scheduler/resources', 'linux');
		expect(layout.runtimeExecutable).toBe('/opt/scheduler/resources/daemon-runtime/runtime/node');
		expect(layout.daemonEntry).toBe('/opt/scheduler/resources/daemon-runtime/bootstrap.mjs');
	});

	it('keeps launch_service free of caller-supplied path arguments', () => {
		const libRs = readFileSync(libRsPath, 'utf8');
		const launchServiceIndex = libRs.indexOf('fn launch_service');
		const signature = libRs.slice(launchServiceIndex, libRs.indexOf('{', launchServiceIndex));

		expect(launchServiceIndex).toBeGreaterThan(-1);
		expect(signature).toContain('tauri::State<LaunchState>');
		expect(signature).not.toContain('file: String');
		expect(signature).not.toContain('args: Vec<String>');
		expect(signature).not.toContain('cwd: String');
	});
});
