import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { handleSecondInstance } from '../src/platform-support.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('desktop single-instance (AC 1, 05-技术栈 决策 25)', () => {
	it('handles second instance invocation by focusing, unminimizing, and showing target window', () => {
		const targetWindow = {
			show: vi.fn(),
			unminimize: vi.fn(),
			setFocus: vi.fn(),
		};

		const result = handleSecondInstance(targetWindow, ['--extra-arg'], 'C:\\path');

		expect(result).toBe(true);
		expect(targetWindow.show).toHaveBeenCalledTimes(1);
		expect(targetWindow.unminimize).toHaveBeenCalledTimes(1);
		expect(targetWindow.setFocus).toHaveBeenCalledTimes(1);
	});

	it('gracefully handles missing window target without throwing', () => {
		const result = handleSecondInstance(undefined, ['--extra-arg'], 'C:\\path');
		expect(result).toBe(false);
	});

	it('configures tauri-plugin-single-instance in Cargo.toml and registers in lib.rs', () => {
		const cargoTomlPath = join(__dirname, '../src-tauri/Cargo.toml');
		const cargoContent = readFileSync(cargoTomlPath, 'utf8');
		expect(cargoContent).toContain('tauri-plugin-single-instance = "2"');

		const libRsPath = join(__dirname, '../src-tauri/src/lib.rs');
		const libRsContent = readFileSync(libRsPath, 'utf8');
		expect(libRsContent).toContain('tauri_plugin_single_instance::init');
		expect(libRsContent).toContain('window.set_focus()');
	});
});
