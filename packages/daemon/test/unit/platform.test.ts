import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUnexpandedPathToken } from '../../src/platform/contract.ts';
import { platformPathAdapter, takePlatformHostInputs } from '../../src/platform/host.ts';
import { resolveExecutable } from '../../src/platform/resolve-executable.ts';
import {
	classifyWindowsPath,
	comSpec,
	windowsAppDataDir,
	windowsExecutableCandidatePaths,
	wrapForComSpec,
} from '../../src/platform/windows.ts';

describe('host adapter', () => {
	it('routes win32 to the Windows adapter', () => {
		expect(platformPathAdapter('win32').platform).toBe('win32');
	});
});

describe('hasUnexpandedPathToken', () => {
	it('accepts Windows 8.3 short names, whose tilde is not a shell expansion', () => {
		// Regression: `includes('~')` rejected the runner's own temp directory
		// (C:\Users\RUNNER~1\AppData\Local\Temp) and every install under PROGRA~1, so the
		// daemon refused to boot on an ordinary Windows machine.
		expect(hasUnexpandedPathToken('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp')).toBe(false);
		expect(hasUnexpandedPathToken('C:\\PROGRA~1\\app\\data')).toBe(false);
		expect(hasUnexpandedPathToken('/home/user~backup/data')).toBe(false);
	});

	it('still rejects a leading tilde, which a shell would expand', () => {
		expect(hasUnexpandedPathToken('~')).toBe(true);
		expect(hasUnexpandedPathToken('~/data')).toBe(true);
		expect(hasUnexpandedPathToken('~user/data')).toBe(true);
	});

	it('still rejects ${...} and %...% tokens', () => {
		expect(hasUnexpandedPathToken('${HOME}/data')).toBe(true);
		expect(hasUnexpandedPathToken('%APPDATA%\\data')).toBe(true);
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

	it('finds Git in an absolute PATH directory on another drive', () => {
		const paths = windowsExecutableCandidatePaths('git', {
			platform: 'win32',
			homedir: 'C:\\Users\\n',
			pathEnv: 'relative;D:\\Program Files\\Git\\cmd;%UNEXPANDED%\\bin',
		});
		expect(paths).toContain('D:\\Program Files\\Git\\cmd\\git.exe');
		expect(paths.some((path) => path.startsWith('relative'))).toBe(false);
		expect(paths.some((path) => path.includes('%UNEXPANDED%'))).toBe(false);
		expect(
			windowsExecutableCandidatePaths('codex', {
				platform: 'win32',
				homedir: 'C:\\Users\\n',
				pathEnv: 'D:\\Program Files\\Git\\cmd',
			}),
		).not.toContain('D:\\Program Files\\Git\\cmd\\codex.exe');
	});
});

describe('wrapForComSpec', () => {
	const COMSPEC_TEST_PATH = 'C:\\Windows\\System32\\cmd.exe';

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

const host = takePlatformHostInputs({});
const isWindowsHost = host.ok && host.value.platform === 'win32';

describe.skipIf(!isWindowsHost)('ComSpec real batch forwarding', () => {
	let directory: string;
	let reportPath: string;
	const layouts = ['plain', 'space 中文 &^%M1_T3_SENTINEL%!'] as const;
	const extensions = ['cmd', 'bat'] as const;
	const argumentCases = [
		[],
		['alpha'],
		['', 'two words', '中文', 'last'],
		['a&b', 'a^b', 'a;b', 'he said "hi"', 'tail\\', 'slash\\"quote'],
		['%M1_T3_SENTINEL%', '!M1_T3_SENTINEL!', '%PATH%', '100%', '!', '%1', '%*'],
		['a"&echo INJECTED>injected.txt&rem "', 'a"|echo INJECTED>piped.txt&rem "'],
		['a"&&echo INJECTED>and.txt&rem "', 'a"||echo INJECTED>or.txt&rem "'],
		['&', '^', ';', '%', '!', '"', '(', ')', '<', '>', '|', '*', '?'],
	] as const;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), 'agsched-comspec-test-'));
		reportPath = join(directory, 'argv.cjs');
		writeFileSync(reportPath, 'console.log(JSON.stringify(process.argv.slice(2)))');
		for (const layout of layouts) {
			const scriptDirectory = join(directory, layout);
			mkdirSync(scriptDirectory);
			for (const extension of extensions) {
				// Model a CLI shim: ComSpec reads the invocation, then the batch forwards %*.
				writeFileSync(
					join(scriptDirectory, `agent.${extension}`),
					`@echo off\r\n"${process.execPath}" "${reportPath}" %*\r\n`,
				);
			}
		}
	});

	afterAll(() => {
		if (directory === undefined) return;
		expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
		rmSync(directory, { recursive: true, force: true });
	});

	for (const layout of layouts) {
		for (const extension of extensions) {
			for (const [caseIndex, originalArgs] of argumentCases.entries()) {
				it(`${layout} .${extension} preserves argv case ${caseIndex}`, async () => {
					const caseDirectory = join(
						directory,
						`case-${layouts.indexOf(layout)}-${extension}-${caseIndex}`,
					);
					mkdirSync(caseDirectory);
					const scriptPath = join(directory, layout, `agent.${extension}`);
					const found = await resolveExecutable({
						hostInputs: { platform: 'win32', homedir: directory },
						executableName: 'agent',
						configuredPath: scriptPath,
						windowsComSpecPath: comSpec(),
					});
					expect(found.ok).toBe(true);
					if (!found.ok) throw new Error(found.error.message);
					expect(found.executable.launchKind).toBe('com-spec');
					expect(found.executable.argsPrefix).toEqual([]);
					const wrapped = wrapForComSpec(
						found.executable.sourcePath,
						originalArgs,
						found.executable.file,
					);
					if (!wrapped.ok) throw new Error(wrapped.error.message);
					const { launch } = wrapped;
					expect(Object.isFrozen(launch)).toBe(true);
					expect(Object.isFrozen(launch.args)).toBe(true);
					expect(Object.isFrozen(launch.spawnOptions)).toBe(true);
					const child = spawnSync(launch.file, [...launch.args], {
						...launch.spawnOptions,
						shell: false,
						windowsHide: true,
						cwd: caseDirectory,
						env: { ...process.env, M1_T3_SENTINEL: 'MUST_NOT_EXPAND' },
						encoding: 'utf8',
						timeout: 15_000,
					});
					expect(child.error).toBeUndefined();
					expect(child.status, child.stderr).toBe(0);
					expect(child.stderr).toBe('');
					expect(JSON.parse(child.stdout)).toEqual(originalArgs);
					for (const marker of ['injected.txt', 'piped.txt', 'and.txt', 'or.txt']) {
						expect(existsSync(join(caseDirectory, marker))).toBe(false);
					}
				});
			}
		}
	}
});
