import { describe, expect, it } from 'vitest';
import {
	ALLOWED_TEMPLATE_VARIABLES,
	SESSION_DIR_OVERWRITE_WARNING_MESSAGE,
	checkSessionDirOverlap,
	detectSessionDirOverlaps,
	formatTemplateErrorHighlight,
	isAllowedTemplateVariable,
	isSamePathIdentity,
	isSameSessionIdentity,
	normalizePathIdentity,
	parseTemplateArgumentTokens,
	renderLaunchTemplate,
	validateLaunchTemplate,
	validateTemplateArgument,
} from '../../src/domain/launch-template.ts';

describe('launch template variable whitelist and argument validation', () => {
	it('only allows {model}, {prompt_file}, {cwd}, {session_dir} as whitelisted variables', () => {
		expect(ALLOWED_TEMPLATE_VARIABLES).toEqual(['model', 'prompt_file', 'cwd', 'session_dir']);

		expect(isAllowedTemplateVariable('model')).toBe(true);
		expect(isAllowedTemplateVariable('prompt_file')).toBe(true);
		expect(isAllowedTemplateVariable('cwd')).toBe(true);
		expect(isAllowedTemplateVariable('session_dir')).toBe(true);

		expect(isAllowedTemplateVariable('unknown')).toBe(false);
		expect(isAllowedTemplateVariable('MODEL')).toBe(false);
		expect(isAllowedTemplateVariable('prompt')).toBe(false);
		expect(isAllowedTemplateVariable('session')).toBe(false);
	});

	it('accepts arguments without variables and arguments with valid whitelisted variables', () => {
		const validArgs = [
			'exec',
			'--json',
			'--model',
			'{model}',
			'--file={prompt_file}',
			'--workdir',
			'{cwd}',
			'--session-dir={session_dir}',
			'--mixed={cwd}/{session_dir}/{model}',
		];

		for (let i = 0; i < validArgs.length; i++) {
			const arg = validArgs[i];
			if (arg !== undefined) {
				expect(validateTemplateArgument(arg, i)).toBeNull();
			}
		}

		const result = validateLaunchTemplate(validArgs);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.template).toEqual(validArgs);
		}
	});

	it('rejects unknown template variables and provides caret highlight at exact position', () => {
		const rawArg = '--custom-flag={unknown_var}';
		const error = validateTemplateArgument(rawArg, 2);

		expect(error).not.toBeNull();
		expect(error?.reason).toBe('unknown-variable');
		expect(error?.variableName).toBe('unknown_var');
		expect(error?.argumentIndex).toBe(2);
		expect(error?.startIndex).toBe(14);
		expect(error?.endIndex).toBe(27);
		expect(error?.highlight).toBe('--custom-flag={unknown_var}\n' + '              ^^^^^^^^^^^^^');
		expect(error?.message).toContain('Unknown template variable "{unknown_var}"');
	});

	it('rejects unclosed opening braces and highlights unclosed span', () => {
		const rawArg = '--dir={session_dir';
		const error = validateTemplateArgument(rawArg, 0);

		expect(error).not.toBeNull();
		expect(error?.reason).toBe('unclosed-brace');
		expect(error?.startIndex).toBe(6);
		expect(error?.endIndex).toBe(18);
		expect(error?.highlight).toBe('--dir={session_dir\n' + '      ^^^^^^^^^^^^');
	});

	it('rejects unexpected closing braces without opening braces', () => {
		const rawArg = 'closing}brace';
		const error = validateTemplateArgument(rawArg, 1);

		expect(error).not.toBeNull();
		expect(error?.reason).toBe('unexpected-closing-brace');
		expect(error?.startIndex).toBe(7);
		expect(error?.endIndex).toBe(8);
		expect(error?.highlight).toBe('closing}brace\n' + '       ^');
	});

	it('rejects empty template variable braces {}', () => {
		const rawArg = '--opt={}';
		const error = validateTemplateArgument(rawArg, 0);

		expect(error).not.toBeNull();
		expect(error?.reason).toBe('empty-variable');
		expect(error?.startIndex).toBe(6);
		expect(error?.endIndex).toBe(8);
		expect(error?.highlight).toBe('--opt={}\n' + '      ^^');
	});

	it('rejects nested opening braces', () => {
		const rawArg = '{{model}}';
		const error = validateTemplateArgument(rawArg, 0);

		expect(error).not.toBeNull();
		expect(error?.reason).toBe('nested-brace');
		expect(error?.startIndex).toBe(1);
		expect(error?.endIndex).toBe(2);
	});

	it('parses valid template argument into tokens accurately', () => {
		const tokens = parseTemplateArgumentTokens('--path={cwd}/sessions/{session_dir}');
		expect(tokens).toEqual([
			{ type: 'literal', text: '--path=' },
			{ type: 'variable', variableName: 'cwd' },
			{ type: 'literal', text: '/sessions/' },
			{ type: 'variable', variableName: 'session_dir' },
		]);
	});

	it('formatTemplateErrorHighlight produces accurate caret lines across columns', () => {
		expect(formatTemplateErrorHighlight('{bad}', 0, 5)).toBe('{bad}\n' + '^^^^^');
		expect(formatTemplateErrorHighlight('foo={bad}', 4, 9)).toBe('foo={bad}\n' + '    ^^^^^');
	});
});

describe('pure template rendering', () => {
	it('substitutes all four whitelisted variables into arguments', () => {
		const template = [
			'--model',
			'{model}',
			'--prompt-file={prompt_file}',
			'--cwd',
			'{cwd}',
			'--session-dir={session_dir}',
		];

		const rendered = renderLaunchTemplate(template, {
			model: 'gpt-4o',
			promptFile: '/tmp/task/prompt.md',
			cwd: '/workspace/project',
			sessionDir: '/var/sessions/agent1',
		});

		expect(rendered).toEqual([
			'--model',
			'gpt-4o',
			'--prompt-file=/tmp/task/prompt.md',
			'--cwd',
			'/workspace/project',
			'--session-dir=/var/sessions/agent1',
		]);
	});

	it('throws an error if template contains invalid syntax', () => {
		expect(() =>
			renderLaunchTemplate(['--flag', '{unclosed'], {
				model: 'm',
				promptFile: 'p',
				cwd: 'c',
				sessionDir: 's',
			}),
		).toThrowError('Invalid launch template');
	});

	it('throws an error if a template variable is missing in context', () => {
		expect(() =>
			renderLaunchTemplate(['--model', '{model}'], {
				model: null,
			}),
		).toThrowError('Missing template variable {model}');

		expect(() =>
			renderLaunchTemplate(['--file={prompt_file}'], {
				promptFile: undefined,
			}),
		).toThrowError('Missing template variable {prompt_file}');
	});
});

describe('cross-platform path identity and session overlap detection', () => {
	it('POSIX: case-sensitive counter-example does not treat different case paths as identical', () => {
		expect(isSamePathIdentity('/usr/bin/agent', '/usr/bin/Agent', 'posix')).toBe(false);

		const agentA = { execPath: '/usr/bin/agent' };
		const agentB = { execPath: '/usr/bin/Agent' };
		expect(
			checkSessionDirOverlap(agentA, agentB, 'agent1', 'agent2', { platform: 'posix' }),
		).toBeNull();
	});

	it('POSIX: backslashes are not converted to slashes on POSIX', () => {
		expect(normalizePathIdentity('path\\with\\backslash', 'posix')).toBe('path\\with\\backslash');
		expect(isSamePathIdentity('/bin/sub\\file', '/bin/sub/file', 'posix')).toBe(false);
	});

	it('Windows: case-insensitive and slash-normalized positive example matches identical executables', () => {
		expect(isSamePathIdentity('C:\\Tools\\Agent.EXE', 'c:/tools/agent.exe', 'win32')).toBe(true);

		const agentA = { execPath: 'C:\\Tools\\Agent.EXE' };
		const agentB = { execPath: 'c:/tools/agent.exe' };
		const warning = checkSessionDirOverlap(agentA, agentB, 'agentA', 'agentB', {
			platform: 'win32',
		});

		expect(warning).not.toBeNull();
		expect(warning?.reason).toBe('session-dir-overlap');
		expect(warning?.message).toBe(SESSION_DIR_OVERWRITE_WARNING_MESSAGE);
		expect(warning?.message).toBe('Session records may overwrite each other');
	});

	it('session identity: same executable with both default session directories warns overlap', () => {
		const agentA = { execPath: '/usr/local/bin/codex' };
		const agentB = { execPath: '/usr/local/bin/codex' };

		expect(isSameSessionIdentity(agentA, agentB, 'posix')).toBe(true);
		const warning = checkSessionDirOverlap(agentA, agentB, 'codex-1', 'codex-2', {
			platform: 'posix',
		});
		expect(warning).not.toBeNull();
		expect(warning?.reason).toBe('session-dir-overlap');
		expect(warning?.sessionDir).toBe('default:/usr/local/bin/codex');
	});

	it('session identity: same executable with same explicit --session-dir warns overlap', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir', '/var/data/sessions'],
		};
		const agentB = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir=/var/data/sessions'],
		};

		expect(isSameSessionIdentity(agentA, agentB, 'posix')).toBe(true);
		const warning = checkSessionDirOverlap(agentA, agentB, 'codex-1', 'codex-2', {
			platform: 'posix',
		});
		expect(warning).not.toBeNull();
	});

	it('session identity: same executable where one specifies --session-dir and one uses default does NOT warn', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir', '/var/custom/sessions'],
		};
		const agentB = {
			execPath: 'codex',
			argsTemplate: ['exec'],
		};

		expect(isSameSessionIdentity(agentA, agentB, 'posix')).toBe(false);
		expect(
			checkSessionDirOverlap(agentA, agentB, 'codex-1', 'codex-2', { platform: 'posix' }),
		).toBeNull();
	});

	it('session identity: same executable with different explicit --session-dir does NOT warn', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir', '/sessions/codex-1'],
		};
		const agentB = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir', '/sessions/codex-2'],
		};

		expect(isSameSessionIdentity(agentA, agentB, 'posix')).toBe(false);
		expect(
			checkSessionDirOverlap(agentA, agentB, 'codex-1', 'codex-2', { platform: 'posix' }),
		).toBeNull();
	});

	it('session identity: POSIX case-sensitive session directories do not match', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['--session-dir', '/var/Sessions'],
		};
		const agentB = {
			execPath: 'codex',
			argsTemplate: ['--session-dir', '/var/sessions'],
		};

		expect(isSameSessionIdentity(agentA, agentB, 'posix')).toBe(false);
		expect(checkSessionDirOverlap(agentA, agentB, 'a', 'b', { platform: 'posix' })).toBeNull();
	});

	it('detectSessionDirOverlaps checks multiple agents and returns all overlap warnings', () => {
		const agents = {
			codex1: {
				execPath: 'codex',
				argsTemplate: ['exec'],
			},
			codex2: {
				execPath: 'codex',
				argsTemplate: ['exec'],
			},
			claude: {
				execPath: 'claude',
				argsTemplate: ['--print'],
			},
		};

		const warnings = detectSessionDirOverlaps(agents);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe('Session records may overwrite each other');
		expect(warnings[0]?.agentId).toBe('codex1');
		expect(warnings[0]?.peerAgentId).toBe('codex2');
	});
});
