import { describe, expect, it } from 'vitest';
import { platformPathAdapter } from '../../src/platform/host.ts';
import {
	classifyWindowsPath,
	quoteForCmd,
	windowsAppDataDir,
	windowsExecutableCandidatePaths,
	wrapForComSpec,
} from '../../src/platform/windows.ts';

describe('host adapter', () => {
	it('routes win32 to the Windows adapter', () => {
		expect(platformPathAdapter('win32').platform).toBe('win32');
	});
});

describe('windowsAppDataDir', () => {
	it('uses APPDATA when absolute and valid', () => {
		const result = windowsAppDataDir({
			platform: 'win32',
			homedir: 'C:\\Users\\n',
			appData: 'C:\\AppData',
		});
		if (!result.ok) throw new Error('unexpected failure');
		expect(result.path).toBe('C:\\AppData\\agent-scheduler');
	});

	it('falls back to homedir Roaming when APPDATA is missing', () => {
		const result = windowsAppDataDir({ platform: 'win32', homedir: 'C:\\Users\\n' });
		if (!result.ok) throw new Error('unexpected failure');
		expect(result.path).toBe('C:\\Users\\n\\AppData\\Roaming\\agent-scheduler');
	});
});

describe('windowsExecutableCandidatePaths', () => {
	it('appends known extensions when name has none', () => {
		const paths = windowsExecutableCandidatePaths('codex', {
			platform: 'win32',
			homedir: 'C:\\Users\\n',
		});
		const names = paths.map((path) => path.split('\\').pop());
		expect(names).toContain('codex.exe');
		expect(names).toContain('codex.cmd');
		expect(names).toContain('codex.bat');
	});

	it('keeps explicit known extension', () => {
		const paths = windowsExecutableCandidatePaths('codex.cmd', {
			platform: 'win32',
			homedir: 'C:\\Users\\n',
		});
		expect(paths.every((path) => path.endsWith('codex.cmd'))).toBe(true);
	});

	it('yields absolute normalized candidates', () => {
		const paths = windowsExecutableCandidatePaths('codex', {
			platform: 'win32',
			homedir: 'C:\\Users\\n',
		});
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(classifyWindowsPath(path).isValidForCurrentPlatform).toBe(true);
		}
	});
});

describe('quoteForCmd', () => {
	it('does not add caret escapes to plain metacharacter arguments', () => {
		expect(quoteForCmd('a&b')).toBe('"a&b"');
		expect(quoteForCmd('a^b')).toBe('"a^b"');
		expect(quoteForCmd('a;b')).toBe('"a;b"');
	});

	it('backslash-escapes embedded quotes and closing backslashes', () => {
		expect(quoteForCmd('he said "hi"')).toBe('"he said \\"hi\\""');
		expect(quoteForCmd('back\\')).toBe('"back\\\\"');
	});
});

describe('wrapForComSpec', () => {
	const COMSPEC_TEST_PATH = 'C:\\Windows\\System32\\cmd.exe';

	it('assembles a fully quoted frozen ComSpec launch object', () => {
		const wrapped = wrapForComSpec('C:\\a b.cmd', ['one', 'a&b', 'x y'], COMSPEC_TEST_PATH);
		expect(wrapped.ok).toBe(true);
		if (!wrapped.ok) return;
		const launch = wrapped.launch;
		expect(launch.file).toBe(COMSPEC_TEST_PATH);
		expect(launch.spawnOptions).toEqual({ windowsVerbatimArguments: true });
		expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
		expect(Object.isFrozen(launch.args)).toBe(true);
		expect(Object.isFrozen(launch)).toBe(true);
		const commandLine = launch.args[3];
		expect(typeof commandLine).toBe('string');
		if (typeof commandLine !== 'string') return;
		const metaChars = ['&', '^', ';', '%', '!', '"'];
		for (const meta of metaChars) {
			expect(commandLine.includes(`"${meta}"`)).toBe(false);
		}
		expect(commandLine).toContain('"C:\\a b.cmd"');
		expect(commandLine).toContain('"a&b"');
		expect(commandLine).toContain('"x y"');
	});

	it('rejects NUL, CR and LF arguments before any child process launch', () => {
		const cases: ReadonlyArray<{
			readonly args: readonly string[];
			readonly expectedIndex: number;
		}> = [
			{ args: ['a\0b'], expectedIndex: 0 },
			{ args: ['ok', 'a\rb'], expectedIndex: 1 },
			{ args: ['x', 'y', 'a\nb'], expectedIndex: 2 },
		];
		for (const { args, expectedIndex } of cases) {
			const wrapped = wrapForComSpec('C:\\script.cmd', args, COMSPEC_TEST_PATH);
			expect(wrapped.ok).toBe(false);
			if (wrapped.ok) continue;
			expect(wrapped.error.code).toBe('E_VALIDATION');
			expect(wrapped.error.details.argumentIndex).toBe(expectedIndex);
		}
	});
});
