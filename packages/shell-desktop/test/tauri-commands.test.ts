import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const libRs = readFileSync(resolve(packageDir, 'src-tauri/src/lib.rs'), 'utf8');
const shellBridge = readFileSync(resolve(packageDir, '../web/src/shell/shell-bridge.ts'), 'utf8');

function parseGenerateHandlerCommands(source: string): string[] {
	const body = /tauri::generate_handler!\[([\s\S]*?)\]/.exec(source)?.[1];
	if (!body) {
		throw new Error('lib.rs is missing tauri::generate_handler!');
	}
	return body
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.sort();
}

function parseWebBridgeCommands(source: string): string[] {
	const body = /const TAURI_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source)?.[1];
	if (!body) {
		throw new Error('shell-bridge.ts is missing TAURI_COMMANDS');
	}
	return [...body.matchAll(/:\s*'([^']+)'/g)].map((match) => match[1] ?? '').sort();
}

describe('M9-T26 Tauri command wiring', () => {
	it('keeps every WebView bridge command registered and no undeclared bridge command in Rust', () => {
		const registered = parseGenerateHandlerCommands(libRs);
		const webBridgeCommands = parseWebBridgeCommands(shellBridge);
		const shellOwnedLauncherCommands = ['get_launch_spec', 'launch_service'];

		expect(registered).toEqual([...webBridgeCommands, ...shellOwnedLauncherCommands].sort());
		expect(registered.filter((name) => !shellOwnedLauncherCommands.includes(name))).toEqual(
			webBridgeCommands,
		);
	});
});
