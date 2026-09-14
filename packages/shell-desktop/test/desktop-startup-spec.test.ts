import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
