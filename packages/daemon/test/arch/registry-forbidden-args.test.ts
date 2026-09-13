import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SECRET_REDACTION_PATTERNS } from '../../src/adapters/probe.ts';
import { BUILT_IN_AGENT_DEFAULTS, BUILT_IN_AGENT_IDS } from '../../src/config/defaults.ts';
import {
	FORBIDDEN_LOGIN_PROBE_ARG_SUBSTRINGS,
	createAgentRegistry,
} from '../../src/config/registry.ts';

const currentDir = resolve(dirname(fileURLToPath(import.meta.url)));
const daemonSrc = resolve(currentDir, '../../src');
const sharedSrc = resolve(daemonSrc, '../../shared/src');

function getAllFiles(dir: string): string[] {
	const results: string[] = [];
	const entries = readdirSync(dir);
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			results.push(...getAllFiles(fullPath));
		} else {
			results.push(fullPath);
		}
	}
	return results;
}

function getAllTsFiles(dir: string): string[] {
	return getAllFiles(dir).filter((file) => {
		const extension = extname(file);
		return extension === '.ts' || extension === '.tsx';
	});
}

describe('M4-T13 / E-353 Arch Test: Forbidden Args and Sensitive Path Scans', () => {
	it('AC 1 & E-353: BUILT_IN_AGENT_DEFAULTS contains no forbidden credential args', () => {
		for (const agentId of Object.values(BUILT_IN_AGENT_IDS)) {
			const config = BUILT_IN_AGENT_DEFAULTS[agentId];
			expect(config.loginProbe).toBeDefined();
			for (const arg of config.loginProbe.args) {
				for (const forbidden of FORBIDDEN_LOGIN_PROBE_ARG_SUBSTRINGS) {
					expect(arg).not.toContain(forbidden);
				}
			}
		}
	});

	it('AC 1 & E-353: Registry rejects loginProbe.args with forbidden credential substrings with invalid-config', async () => {
		const warnings: { reason: string; field?: string }[] = [];
		const files = new Map<string, string>();
		const configPath = '/test/data/agents.json';

		for (const forbidden of FORBIDDEN_LOGIN_PROBE_ARG_SUBSTRINGS) {
			files.set(
				configPath,
				JSON.stringify(
					{
						schemaVersion: 1,
						overrides: {
							codex: {
								loginProbe: {
									args: ['auth', forbidden],
								},
							},
						},
					},
					null,
					2,
				),
			);

			warnings.length = 0;
			const registry = createAgentRegistry({
				dataDir: '/test/data',
				platform: 'posix',
				publishWarning: (w) => {
					warnings.push({ reason: w.reason, field: w.field });
				},
				fileSystem: {
					readUtf8File: async (p) => {
						const norm = p.replaceAll('\\', '/');
						return files.get(norm) ?? files.get(p) ?? '{}';
					},
					writeUtf8File: async (p, c) => {
						const norm = p.replaceAll('\\', '/');
						files.set(norm, c);
					},
					watchDirectory: () => {
						const watcher = { close: () => undefined, on: () => watcher };
						return watcher;
					},
				},
			});

			const reloadResult = await registry.reload();
			expect(reloadResult.status).toBe('rejected');
			expect(warnings.some((w) => w.reason === 'invalid-config')).toBe(true);
		}
	});

	it('AC 1 & E-349: Registry rejects {provider} placeholder when parser is not pi_auth_check', async () => {
		const warnings: { reason: string; field?: string }[] = [];
		const files = new Map<string, string>();
		const configPath = '/test/data/agents.json';

		files.set(
			configPath,
			JSON.stringify(
				{
					schemaVersion: 1,
					overrides: {
						codex: {
							loginProbe: {
								parser: 'codex_login_status',
								args: ['check', '{provider}'],
							},
						},
					},
				},
				null,
				2,
			),
		);

		const registry = createAgentRegistry({
			dataDir: '/test/data',
			platform: 'posix',
			publishWarning: (w) => {
				warnings.push({ reason: w.reason, field: w.field });
			},
			fileSystem: {
				readUtf8File: async (p) => {
					const norm = p.replaceAll('\\', '/');
					return files.get(norm) ?? files.get(p) ?? '{}';
				},
				writeUtf8File: async (p, c) => {
					const norm = p.replaceAll('\\', '/');
					files.set(norm, c);
				},
				watchDirectory: () => {
					const watcher = { close: () => undefined, on: () => watcher };
					return watcher;
				},
			},
		});

		const reloadResult = await registry.reload();
		expect(reloadResult.status).toBe('rejected');
		expect(warnings.some((w) => w.reason === 'invalid-config')).toBe(true);
	});

	it('AC 6 & E-353: No auth.json, credentials.json, or .credentials path strings in daemon or shared source', () => {
		const allFiles = [...getAllTsFiles(daemonSrc), ...getAllTsFiles(sharedSrc)];
		const violations: { file: string; match: string }[] = [];

		const forbiddenPathRegex = /(?:auth\.json|credentials\.json|[\\/]\.credentials\b)/i;

		for (const file of allFiles) {
			const content = readFileSync(file, 'utf8');
			const sourceFile = ts.createSourceFile(
				file,
				content,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);

			function checkNode(node: ts.Node) {
				if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
					const text = node.text;
					if (forbiddenPathRegex.test(text)) {
						violations.push({ file, match: text });
					}
				}
				ts.forEachChild(node, checkNode);
			}

			checkNode(sourceFile);
		}

		expect(violations).toEqual([]);
	});

	it('AC 6 & E-353: Prohibited login literals (logged in, loggedIn, not_ready, auth check) appear ONLY in adapters/login-probe.ts and adapters/grok/login-patterns.ts', () => {
		const allFiles = [...getAllTsFiles(daemonSrc), ...getAllTsFiles(sharedSrc)];
		const violations: { file: string; text: string }[] = [];

		const forbiddenLiteralRegex = /^(?:logged in|loggedIn|not_ready|auth check)$/;

		for (const file of allFiles) {
			const normalizedPath = file.replaceAll('\\', '/');
			if (
				normalizedPath.endsWith('adapters/login-probe.ts') ||
				normalizedPath.endsWith('adapters/grok/login-patterns.ts')
			) {
				continue;
			}

			const content = readFileSync(file, 'utf8');
			const sourceFile = ts.createSourceFile(
				file,
				content,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);

			function checkNode(node: ts.Node) {
				if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
					const text = node.text;
					if (forbiddenLiteralRegex.test(text.trim())) {
						violations.push({ file, text });
					}
				}
				ts.forEachChild(node, checkNode);
			}

			checkNode(sourceFile);
		}

		expect(violations).toEqual([]);
	});

	it('E-354: no fixture file carries a real-looking token', () => {
		const fixturesDir = resolve(currentDir, '../fixtures');
		const violations: { file: string; pattern: string; match: string }[] = [];

		for (const file of getAllFiles(fixturesDir)) {
			const content = readFileSync(file, 'utf8');
			for (const [name, pattern] of Object.entries(SECRET_REDACTION_PATTERNS)) {
				for (const match of content.match(pattern) ?? []) {
					violations.push({ file, pattern: name, match });
				}
			}
		}

		expect(violations).toEqual([]);
	});

	it('AC 5: service/agents.ts contains no setInterval', () => {
		const agentsServiceFile = join(daemonSrc, 'service/agents.ts');
		const content = readFileSync(agentsServiceFile, 'utf8');
		expect(content).not.toContain('setInterval');
	});
});
