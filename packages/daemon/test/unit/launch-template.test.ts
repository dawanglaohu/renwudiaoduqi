import { describe, expect, it } from 'vitest';
import {
	ALLOWED_TEMPLATE_VARIABLES,
	SESSION_DIR_OVERWRITE_WARNING_MESSAGE,
	assertAgentsForSave,
	assertValidLaunchTemplate,
	checkSessionDirOverlap,
	detectSessionDirOverlaps,
	formatTemplateErrorHighlight,
	isAllowedTemplateVariable,
	parseTemplateArgumentTokens,
	renderLaunchTemplate,
	validateAgentsForSave,
	validateLaunchTemplate,
	validateTemplateArgument,
} from '../../src/domain/launch-template.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('launch template variable whitelist and parsing (Criterion 1 & E-89)', () => {
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
			if (arg !== undefined) expect(validateTemplateArgument(arg, i)).toBeNull();
		}

		const result = validateLaunchTemplate(validArgs);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.template).toEqual(validArgs);
		}
	});

	it('E-89: rejects unknown template variables and provides caret highlight at exact position', () => {
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

	it('E-89: rejects unclosed opening braces and highlights unclosed span', () => {
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

describe('save-time validation and rejection (Criterion 1 & E-89)', () => {
	it('assertAgentsForSave rejects configurations containing unknown template variables', () => {
		const agents = {
			codex: {
				execPath: 'codex',
				argsTemplate: ['exec', '--model', '{bad_model}'],
			},
		};

		expect(() => assertAgentsForSave(agents)).toThrowError(AppError);
		try {
			assertAgentsForSave(agents);
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			const appErr = error as AppError;
			expect(appErr.code).toBe('E_VALIDATION');
			expect(appErr.message).toContain('{bad_model}');
			expect(appErr.details?.agentId).toBe('codex');
			expect(appErr.details?.argumentIndex).toBe(2);
			expect(appErr.details?.reason).toBe('unknown-variable');
			expect(appErr.details?.highlight).toContain('^^^^^^^^^^^');
		}
	});

	it('validateAgentsForSave rejects unclosed braces with typed validation error', () => {
		const agents = {
			claude: {
				execPath: 'claude',
				argsTemplate: ['--output-format', 'stream-json', '--model={model'],
			},
		};

		const result = validateAgentsForSave(agents);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.agentId).toBe('claude');
			expect(result.error.reason).toBe('unclosed-brace');
			expect(result.appError.code).toBe('E_VALIDATION');
			expect(result.appError.details?.highlight).toContain('^^^^^^');
		}
	});

	it('validateAgentsForSave succeeds for valid configurations', () => {
		const agents = {
			codex: {
				execPath: 'codex',
				argsTemplate: ['exec', '--json', '--model', '{model}'],
			},
			claude: {
				execPath: 'claude',
				argsTemplate: ['--print', '--output-format', 'stream-json', '--model', '{model}'],
			},
		};

		const result = validateAgentsForSave(agents);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Object.keys(result.validatedTemplates)).toEqual(['codex', 'claude']);
		}
	});
});

describe('runtime safe usage and execution (Criterion 2)', () => {
	it('assertValidLaunchTemplate throws E_VALIDATION for unvalidated templates', () => {
		expect(() => assertValidLaunchTemplate(['--invalid={foo}'], 'test-agent')).toThrowError(
			AppError,
		);
	});

	it('renderLaunchTemplate enforces validation before rendering and refuses invalid templates', () => {
		const unvalidatedTemplate = ['--flag', '{unclosed_brace'];
		expect(() =>
			renderLaunchTemplate(unvalidatedTemplate, {
				model: 'test',
				promptFile: '/tmp/p',
				cwd: '/tmp/c',
				sessionDir: '/tmp/s',
			}),
		).toThrowError(AppError);
	});

	it('renderLaunchTemplate substitutes all whitelisted variables correctly', () => {
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

	it('renderLaunchTemplate omits --model and {model} when model is null or undefined (E-35 / M4-T6)', () => {
		const template = ['exec', '--json', '--model', '{model}', '--prompt={prompt_file}'];

		const rendered = renderLaunchTemplate(template, {
			model: null,
			promptFile: '/tmp/prompt.txt',
		});

		expect(rendered).toEqual(['exec', '--json', '--prompt=/tmp/prompt.txt']);
	});

	it('renderLaunchTemplate throws E_VALIDATION if required template variable is missing in context', () => {
		const template = ['exec', '--prompt={prompt_file}'];

		expect(() =>
			renderLaunchTemplate(template, {
				promptFile: null,
			}),
		).toThrowError(AppError);

		try {
			renderLaunchTemplate(template, { promptFile: null });
		} catch (error) {
			const appErr = error as AppError;
			expect(appErr.code).toBe('E_VALIDATION');
			expect(appErr.message).toContain('{prompt_file}');
		}
	});
});

describe('duplicate executable path and session directory overlap (Criterion 3 & E-95)', () => {
	it('E-95: allows two agents with same executable path, but warns if session directory is identical', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['exec', '--json', '--model', '{model}'],
		};
		// User copied configuration from codex without changing path or session directory
		const agentB = {
			execPath: 'codex',
			argsTemplate: ['exec', '--json', '--model', '{model}'],
		};

		const warning = checkSessionDirOverlap(agentA, agentB, 'codex-1', 'codex-2');
		expect(warning).not.toBeNull();
		expect(warning?.reason).toBe('session-dir-overlap');
		expect(warning?.message).toBe(SESSION_DIR_OVERWRITE_WARNING_MESSAGE);
		expect(warning?.message).toBe('会话记录可能互相覆盖');
		expect(warning?.agentId).toBe('codex-1');
		expect(warning?.peerAgentId).toBe('codex-2');
	});

	it('E-95: warns when both agents explicitly configure the same session directory', () => {
		const agentA = {
			execPath: '/usr/local/bin/pi',
			argsTemplate: ['--mode', 'rpc', '--session-dir', '/shared/sessions'],
		};
		const agentB = {
			execPath: '/usr/local/bin/pi',
			argsTemplate: ['--mode', 'rpc', '--session-dir=/shared/sessions'],
		};

		const warning = checkSessionDirOverlap(agentA, agentB, 'pi-a', 'pi-b');
		expect(warning).not.toBeNull();
		expect(warning?.message).toBe('会话记录可能互相覆盖');
	});

	it('E-95: does NOT warn if two agents with same executable have different session directories', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir', '/sessions/codex-1'],
		};
		const agentB = {
			execPath: 'codex',
			argsTemplate: ['exec', '--session-dir', '/sessions/codex-2'],
		};

		const warning = checkSessionDirOverlap(agentA, agentB, 'codex-1', 'codex-2');
		expect(warning).toBeNull();
	});

	it('E-95: does NOT warn if two agents have different executables', () => {
		const agentA = {
			execPath: 'codex',
			argsTemplate: ['exec', '--model', '{model}'],
		};
		const agentB = {
			execPath: 'claude',
			argsTemplate: ['--print', '--model', '{model}'],
		};

		const warning = checkSessionDirOverlap(agentA, agentB, 'codex', 'claude');
		expect(warning).toBeNull();
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
		expect(warnings[0]?.message).toBe('会话记录可能互相覆盖');
		expect(warnings[0]?.agentId).toBe('codex1');
		expect(warnings[0]?.peerAgentId).toBe('codex2');
	});

	it('validateAgentsForSave returns warnings while permitting save (Criterion 3)', () => {
		const agents = {
			codex1: {
				execPath: 'codex',
				argsTemplate: ['exec', '--model', '{model}'],
			},
			codex2: {
				execPath: 'codex',
				argsTemplate: ['exec', '--model', '{model}'],
			},
		};

		const result = validateAgentsForSave(agents);
		// Criterion 3: Allowed (ok: true), but gives warning
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]?.message).toBe('会话记录可能互相覆盖');
		}
	});
});
