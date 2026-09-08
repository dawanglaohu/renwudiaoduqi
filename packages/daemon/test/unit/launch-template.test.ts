import { describe, expect, it } from 'vitest';
import {
	ALLOWED_TEMPLATE_VARIABLES,
	detectSessionDirOverlaps,
	renderLaunchTemplate,
	validateLaunchTemplate,
} from '../../src/domain/launch-template.ts';

describe('launch template validation', () => {
	it('accepts only the four declared variables and returns an immutable template', () => {
		expect(ALLOWED_TEMPLATE_VARIABLES).toEqual(['model', 'prompt_file', 'cwd', 'session_dir']);
		const args = [
			'exec',
			'--model={model}',
			'--file={prompt_file}',
			'--cwd={cwd}',
			'--session-dir={session_dir}',
		];
		const result = validateLaunchTemplate(args);
		expect(result).toEqual({ ok: true, template: args });
		if (result.ok) expect(Object.isFrozen(result.template)).toBe(true);
	});

	it.each([
		{
			argument: '--custom-flag={unknown_var}',
			reason: 'unknown-variable',
			startIndex: 14,
			endIndex: 27,
			highlight: '--custom-flag={unknown_var}\n              ^^^^^^^^^^^^^',
		},
		{
			argument: '--dir={session_dir',
			reason: 'unclosed-brace',
			startIndex: 6,
			endIndex: 18,
			highlight: '--dir={session_dir\n      ^^^^^^^^^^^^',
		},
		{
			argument: 'closing}brace',
			reason: 'unexpected-closing-brace',
			startIndex: 7,
			endIndex: 8,
			highlight: 'closing}brace\n       ^',
		},
		{
			argument: '--opt={}',
			reason: 'empty-variable',
			startIndex: 6,
			endIndex: 8,
			highlight: '--opt={}\n      ^^',
		},
		{
			argument: '{{model}}',
			reason: 'nested-brace',
			startIndex: 1,
			endIndex: 2,
			highlight: '{{model}}\n ^',
		},
	])('rejects $reason with exact location and highlight', (expected) => {
		const result = validateLaunchTemplate(['before', expected.argument]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			argumentIndex: 1,
			rawArgument: expected.argument,
			reason: expected.reason,
			startIndex: expected.startIndex,
			endIndex: expected.endIndex,
			highlight: expected.highlight,
		});
	});
});

describe('launch template rendering', () => {
	it('substitutes all four variables after validation', () => {
		const result = renderLaunchTemplate(
			[
				'--model={model}',
				'--prompt-file={prompt_file}',
				'--cwd={cwd}',
				'--session-dir={session_dir}',
			],
			{
				model: 'gpt-4o',
				promptFile: '/tmp/task/prompt.md',
				cwd: '/workspace/project',
				sessionDir: '/var/sessions/agent1',
			},
		);

		expect(result).toEqual({
			ok: true,
			args: [
				'--model=gpt-4o',
				'--prompt-file=/tmp/task/prompt.md',
				'--cwd=/workspace/project',
				'--session-dir=/var/sessions/agent1',
			],
		});
	});

	it('returns the original validation location instead of rendering invalid syntax', () => {
		const result = renderLaunchTemplate(['ok', '{unclosed'], {});
		expect(result).toMatchObject({
			ok: false,
			error: {
				reason: 'invalid-template',
				validationError: { argumentIndex: 1, reason: 'unclosed-brace', startIndex: 0 },
			},
		});
	});

	it('returns the missing context variable and argument without partial output', () => {
		const result = renderLaunchTemplate(['before', '--model={model}', 'after'], { model: null });
		expect(result).toEqual({
			ok: false,
			error: {
				reason: 'missing-variable',
				message: 'Missing template variable {model} for argument 1 ("--model={model}")',
				variableName: 'model',
				argumentIndex: 1,
				rawArgument: '--model={model}',
			},
		});
	});
});

describe('session directory overlap detection', () => {
	it('preserves POSIX case and backslashes', () => {
		expect(
			detectSessionDirOverlaps(
				{
					lower: { execPath: '/opt/foo.exe' },
					upper: { execPath: '/opt/Foo.exe' },
					slash: { execPath: '/bin/sub/file' },
					backslash: { execPath: '/bin/sub\\file' },
				},
				{ platform: 'posix' },
			),
		).toEqual([]);
	});

	it('normalizes Windows case and slash direction', () => {
		const warnings = detectSessionDirOverlaps(
			{
				first: { execPath: 'C:\\Tools\\Agent.EXE' },
				second: { execPath: 'c:/tools/agent.exe' },
			},
			{ platform: 'win32' },
		);
		expect(warnings).toEqual([
			expect.objectContaining({
				reason: 'session-dir-overlap',
				message: 'Session records may overwrite each other',
				agentId: 'first',
				peerAgentId: 'second',
			}),
		]);
	});

	it('warns for a copied config with the same explicit session directory', () => {
		const warnings = detectSessionDirOverlaps({
			first: {
				execPath: 'agent',
				argsTemplate: ['exec', '--session-dir', '/sessions/shared'],
			},
			second: {
				execPath: 'agent',
				argsTemplate: ['exec', '--session-dir=/sessions/shared'],
			},
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			reason: 'session-dir-overlap',
			sessionDir: '/sessions/shared',
		});
	});

	it('allows the same executable with different explicit session directories', () => {
		expect(
			detectSessionDirOverlaps({
				first: { execPath: 'agent', argsTemplate: ['--session-dir', '/sessions/first'] },
				second: { execPath: 'agent', argsTemplate: ['--session-dir', '/sessions/second'] },
			}),
		).toEqual([]);
	});
});
