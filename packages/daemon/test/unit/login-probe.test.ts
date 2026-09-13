import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseLoginOutput, probeLogin } from '../../src/adapters/login-probe.ts';
import { redactSecrets } from '../../src/adapters/probe.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import type { ExecutableFileInfo, ExecutableFileSystem } from '../../src/platform/contract.ts';
import { createAgentService } from '../../src/service/agents.ts';

const currentDir = resolve(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = resolve(currentDir, '../fixtures/login');

function readFixture(filename: string): string {
	return readFileSync(join(fixturesDir, filename), 'utf8');
}

function createMockFileStat(
	isFile = true,
	isSymbolicLink = false,
	mtimeMs = 1000,
	size = 2048,
): ExecutableFileInfo {
	return {
		isFile: () => isFile,
		isSymbolicLink: () => isSymbolicLink,
		mtimeMs,
		size,
	} as unknown as ExecutableFileInfo;
}

function createMockRegistry(overrides: Record<string, unknown> = {}) {
	const files = new Map<string, string>();
	const configPath = '/test/data/agents.json';
	files.set(
		configPath,
		JSON.stringify(
			{
				schemaVersion: 1,
				overrides,
			},
			null,
			2,
		),
	);

	const mockFs = {
		readUtf8File: async (p: string) => {
			const normalized = p.replaceAll('\\', '/');
			return files.get(normalized) ?? files.get(p) ?? '{}';
		},
		writeUtf8File: async (p: string, c: string) => {
			const normalized = p.replaceAll('\\', '/');
			files.set(normalized, c);
		},
		watchDirectory: () => {
			const watcher = { close: () => undefined, on: () => watcher };
			return watcher;
		},
	};

	return createAgentRegistry({
		dataDir: '/test/data',
		platform: 'posix',
		publishWarning: () => undefined,
		fileSystem: mockFs,
	});
}

describe('M4-T13: 登录态探测与刷新 (login-probe)', () => {
	describe('AC 1 & AC 2: 四解析器 × 五家 fixture', () => {
		// 1. codex
		it('codex: matches logged in fixture -> logged_in', () => {
			const stdout = readFixture('codex-login-status.logged-in.stdout.txt');
			const parsed = parseLoginOutput({
				parser: 'codex_login_status',
				stdout,
				stderr: '',
				exitCode: 0,
				loggedInPattern: '^Logged in',
				loggedOutPattern: 'not logged in',
			});

			expect(parsed.state).toBe('logged_in');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
		});

		it('codex: matches synthetic logged out fixture -> logged_out', () => {
			const stdout = readFixture('codex-login-status.logged-out.synthetic.txt');
			const parsed = parseLoginOutput({
				parser: 'codex_login_status',
				stdout,
				stderr: '',
				exitCode: 1,
				loggedInPattern: '^Logged in',
				loggedOutPattern: 'not logged in',
			});

			expect(parsed.state).toBe('logged_out');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
		});

		it('codex: exit code 0 but unparsable output -> unknown/unparsable with E_AGENT_LOGIN_PROBE_FAILED', () => {
			const parsed = parseLoginOutput({
				parser: 'codex_login_status',
				stdout: 'unexpected random status output\n',
				stderr: '',
				exitCode: 0,
				loggedInPattern: '^Logged in',
				loggedOutPattern: 'not logged in',
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('unparsable');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		it('codex: non-zero exit code without matching loggedOutPattern -> unknown/exit_nonzero with E_AGENT_LOGIN_PROBE_FAILED', () => {
			const parsed = parseLoginOutput({
				parser: 'codex_login_status',
				stdout: '',
				stderr: 'FATAL: internal crash\n',
				exitCode: 2,
				loggedInPattern: '^Logged in',
				loggedOutPattern: 'not logged in',
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('exit_nonzero');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		// 2. claude
		it('claude: matches loggedOut fixture -> logged_out with apiProvider in vendor', () => {
			const stdout = readFixture('claude-auth-status.logged-out.stdout.json');
			const parsed = parseLoginOutput({
				parser: 'claude_auth_json',
				stdout,
				stderr: '',
				exitCode: 0,
			});

			expect(parsed.state).toBe('logged_out');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
			expect(parsed.vendor).toBe('firstParty');
		});

		it('claude: matches synthetic loggedIn fixture -> logged_in with apiProvider in vendor', () => {
			const stdout = readFixture('claude-auth-status.logged-in.synthetic.json');
			const parsed = parseLoginOutput({
				parser: 'claude_auth_json',
				stdout,
				stderr: '',
				exitCode: 0,
			});

			expect(parsed.state).toBe('logged_in');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
			expect(parsed.vendor).toBe('firstParty');
		});

		it('claude: non-json output with exitCode 1 -> unknown/exit_nonzero with E_AGENT_LOGIN_PROBE_FAILED', () => {
			const stdout = readFixture('claude-auth-status.non-json.txt');
			const parsed = parseLoginOutput({
				parser: 'claude_auth_json',
				stdout,
				stderr: 'Failed to connect',
				exitCode: 1,
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('exit_nonzero');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		it('claude: unparsable output with exitCode 0 -> unknown/unparsable with E_AGENT_LOGIN_PROBE_FAILED', () => {
			const parsed = parseLoginOutput({
				parser: 'claude_auth_json',
				stdout: 'not a json at all',
				stderr: '',
				exitCode: 0,
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('unparsable');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		// 3. grok
		it('grok: exit code 0 with models output fixture -> logged_in', () => {
			const stdout = readFixture('grok-models.success.stdout.txt');
			const parsed = parseLoginOutput({
				parser: 'grok_models_exit',
				stdout,
				stderr: '',
				exitCode: 0,
			});

			expect(parsed.state).toBe('logged_in');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
		});

		it('grok: exit code 1 with auth error synthetic fixture -> logged_out', () => {
			const stderr = readFixture('grok-models.auth-error.synthetic.txt');
			const parsed = parseLoginOutput({
				parser: 'grok_models_exit',
				stdout: '',
				stderr,
				exitCode: 1,
			});

			expect(parsed.state).toBe('logged_out');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
		});

		it('grok: exit code 1 with network error synthetic fixture -> unknown/exit_nonzero (E-335: does not mistake network error for logged_out)', () => {
			const stderr = readFixture('grok-models.network-error.synthetic.txt');
			const parsed = parseLoginOutput({
				parser: 'grok_models_exit',
				stdout: '',
				stderr,
				exitCode: 1,
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('exit_nonzero');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		// 4. pi
		it('pi: status ready fixture -> logged_in', () => {
			const stdout = readFixture('pi-auth-check.ready.stdout.json');
			const parsed = parseLoginOutput({
				parser: 'pi_auth_check',
				stdout,
				stderr: '',
				exitCode: 0,
			});

			expect(parsed.state).toBe('logged_in');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
		});

		it('pi: status not_ready fixture -> logged_out', () => {
			const stdout = readFixture('pi-auth-check.not-ready.stdout.json');
			const parsed = parseLoginOutput({
				parser: 'pi_auth_check',
				stdout,
				stderr: '',
				exitCode: 1,
			});

			expect(parsed.state).toBe('logged_out');
			expect(parsed.reason).toBeNull();
			expect(parsed.warningCode).toBeNull();
		});

		it('pi: status invalid fixture -> unknown/unparsable (AC 2)', () => {
			const stdout = readFixture('pi-auth-check.invalid.stdout.json');
			const parsed = parseLoginOutput({
				parser: 'pi_auth_check',
				stdout,
				stderr: '',
				exitCode: 2,
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('unparsable');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		it('pi: missing provider stderr fixture -> unknown/exit_nonzero with E_AGENT_LOGIN_PROBE_FAILED', () => {
			const stderr = readFixture('pi-auth-check.missing-provider.stderr.txt');
			const parsed = parseLoginOutput({
				parser: 'pi_auth_check',
				stdout: '',
				stderr,
				exitCode: 2,
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('exit_nonzero');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});

		it('timeout maps to unknown/timeout with E_AGENT_LOGIN_PROBE_FAILED', () => {
			const parsed = parseLoginOutput({
				parser: 'grok_models_exit',
				stdout: '',
				stderr: '',
				exitCode: null,
				timedOut: true,
			});

			expect(parsed.state).toBe('unknown');
			expect(parsed.reason).toBe('timeout');
			expect(parsed.warningCode).toBe('E_AGENT_LOGIN_PROBE_FAILED');
		});
	});

	describe('AC 3 & E-349: pi multi-provider probing and limits', () => {
		it('extracts distinct providers from pi-list-models.stdout.txt and probes them in parallel', async () => {
			const piListOutput = readFixture('pi-list-models.stdout.txt');
			const lines = piListOutput.trim().split('\n').slice(1);
			const providersFromTable: string[] = Array.from(
				new Set(
					lines
						.map((line) => line.trim().split(/\s+/)[0])
						.filter((p): p is string => typeof p === 'string' && p.length > 0),
				),
			);

			expect(providersFromTable).toEqual(['cc-switch-deep-seek', 'antigravity']);

			const mockRunner = vi.fn(async (params: { args: readonly string[] }) => {
				const providerArgIdx = params.args.indexOf('--provider');
				const provider = providerArgIdx >= 0 ? params.args[providerArgIdx + 1] : '';

				if (provider === 'cc-switch-deep-seek') {
					return {
						ok: true,
						exitCode: 0,
						stdout: readFixture('pi-auth-check.ready.stdout.json'),
						stderr: '',
					};
				}
				return {
					ok: false,
					exitCode: 1,
					stdout: readFixture('pi-auth-check.not-ready.stdout.json'),
					stderr: '',
				};
			});

			// defaultProvider = cc-switch-deep-seek -> agent-level state is logged_in
			const resultLoggedIn = await probeLogin({
				agentId: 'pi',
				config: BUILT_IN_AGENT_DEFAULTS.pi,
				resolvedPath: '/usr/local/bin/pi',
				providers: providersFromTable,
				defaultProvider: 'cc-switch-deep-seek',
				commandRunner: mockRunner,
			});

			expect(resultLoggedIn).not.toBeNull();
			expect(resultLoggedIn?.state).toBe('logged_in');
			expect(resultLoggedIn?.reason).toBeNull();
			expect(resultLoggedIn?.providers?.['cc-switch-deep-seek']?.state).toBe('logged_in');
			expect(resultLoggedIn?.providers?.antigravity?.state).toBe('logged_out');

			// defaultProvider = antigravity -> agent-level state is logged_out
			const resultLoggedOut = await probeLogin({
				agentId: 'pi',
				config: BUILT_IN_AGENT_DEFAULTS.pi,
				resolvedPath: '/usr/local/bin/pi',
				providers: providersFromTable,
				defaultProvider: 'antigravity',
				commandRunner: mockRunner,
			});

			expect(resultLoggedOut?.state).toBe('logged_out');
			expect(resultLoggedOut?.reason).toBeNull();

			// defaultProvider missing -> picks first logged_in provider ('cc-switch-deep-seek')
			const resultDefault = await probeLogin({
				agentId: 'pi',
				config: BUILT_IN_AGENT_DEFAULTS.pi,
				resolvedPath: '/usr/local/bin/pi',
				providers: providersFromTable,
				commandRunner: mockRunner,
			});

			expect(resultDefault?.state).toBe('logged_in');
		});

		it('when provider list and defaultProvider are both empty -> no_provider without starting process', async () => {
			const mockRunner = vi.fn();
			const result = await probeLogin({
				agentId: 'pi',
				config: BUILT_IN_AGENT_DEFAULTS.pi,
				resolvedPath: '/usr/local/bin/pi',
				providers: [],
				defaultProvider: null,
				commandRunner: mockRunner,
			});

			expect(result).not.toBeNull();
			expect(result?.state).toBe('unknown');
			expect(result?.reason).toBe('no_provider');
			expect(result?.warningCode).toBeNull();
			expect(mockRunner).not.toHaveBeenCalled();
		});

		it('enforces 10 provider limit and marks 11th+ as not_probed', async () => {
			const twelveProviders = Array.from({ length: 12 }, (_, i) => `provider-${i + 1}`);
			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: '{"status":"ready","provider":"p"}',
				stderr: '',
			}));

			const result = await probeLogin({
				agentId: 'pi',
				config: BUILT_IN_AGENT_DEFAULTS.pi,
				resolvedPath: '/usr/local/bin/pi',
				providers: twelveProviders,
				defaultProvider: 'provider-1',
				commandRunner: mockRunner,
			});

			expect(mockRunner).toHaveBeenCalledTimes(10);
			expect(result?.providers?.['provider-10']?.state).toBe('logged_in');
			expect(result?.providers?.['provider-11']?.state).toBe('unknown');
			expect(result?.providers?.['provider-11']?.reason).toBe('not_probed');
			expect(result?.providers?.['provider-12']?.state).toBe('unknown');
			expect(result?.providers?.['provider-12']?.reason).toBe('not_probed');
		});

		it('parser=none (dsh) does not start process and returns null', async () => {
			const mockRunner = vi.fn();
			const result = await probeLogin({
				agentId: 'dsh',
				config: BUILT_IN_AGENT_DEFAULTS.dsh,
				resolvedPath: '/usr/local/bin/dsh',
				commandRunner: mockRunner,
			});

			expect(result).toBeNull();
			expect(mockRunner).not.toHaveBeenCalled();
		});

		it('empty resolvedPath produces unknown/exec_missing without starting process', async () => {
			const mockRunner = vi.fn();
			const result = await probeLogin({
				agentId: 'codex',
				config: BUILT_IN_AGENT_DEFAULTS.codex,
				resolvedPath: '',
				commandRunner: mockRunner,
			});

			expect(result?.state).toBe('unknown');
			expect(result?.reason).toBe('exec_missing');
			expect(result?.warningCode).toBeNull();
			expect(mockRunner).not.toHaveBeenCalled();
		});
	});

	describe('AC 6 & E-354: redactSecrets() Five Sample Types', () => {
		it('redacts sk- tokens', () => {
			const input = 'Error: invalid key sk-proj-1234567890abcdef12345678 in request';
			const redacted = redactSecrets(input);
			expect(redacted).toBe('Error: invalid key [REDACTED] in request');
		});

		it('redacts xai- tokens', () => {
			const input = 'Token xai-abcdef1234567890abcdef is expired';
			const redacted = redactSecrets(input);
			expect(redacted).toBe('Token [REDACTED] is expired');
		});

		it('redacts ghp_ tokens', () => {
			const input = 'PAT ghp_1234567890abcdef1234567890abcdef12 rejected';
			const redacted = redactSecrets(input);
			expect(redacted).toBe('PAT [REDACTED] rejected');
		});

		it('redacts Bearer tokens', () => {
			const input = 'Authorization: Bearer mySecretAccessToken12345\n';
			const redacted = redactSecrets(input);
			expect(redacted).toBe('Authorization: Bearer [REDACTED]\n');
		});

		it('redacts JWT three-segment tokens', () => {
			const jwt =
				'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozGzTqQDgZsWqT942Y3hQ12345';
			const input = `User token: ${jwt} was provided`;
			const redacted = redactSecrets(input);
			expect(redacted).toBe('User token: [REDACTED] was provided');
		});

		it('does NOT accidentally redact gpt-5.6-sol or opus[1m]', () => {
			const input = 'Selecting model gpt-5.6-sol and fallback opus[1m] for execution';
			const redacted = redactSecrets(input);
			expect(redacted).toBe(input);
		});
	});

	describe('AC 4, AC 5, AC 7: AgentService integration, caching, deduplication, invalidation', () => {
		async function createTestAgentService(
			customRunner?: (p: { file: string; args: readonly string[] }) => Promise<{
				ok: boolean;
				exitCode: number;
				stdout: string;
				stderr: string;
			}>,
		) {
			const ringBuffer = createRingBuffer();
			const bus = createEventBus({ ringBuffer });
			const envelopeFactory = createEnvelopeFactory({
				clock: { now: () => '2026-09-12T02:00:00.000Z' },
				idAllocator: { allocate: () => 1 },
			});
			const registry = createMockRegistry({
				codex: { execPath: '/usr/local/bin/codex' },
				claude: { execPath: '/usr/local/bin/claude' },
			});

			const runner =
				customRunner ??
				(async (params: { file: string; args: readonly string[] }) => {
					if (params.file.includes('claude')) {
						if (params.args.includes('auth')) {
							return {
								ok: true,
								exitCode: 0,
								stdout: '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}\n',
								stderr: '',
							};
						}
						return { ok: true, exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
					}
					if (params.file.includes('codex')) {
						if (params.args.includes('login')) {
							return {
								ok: true,
								exitCode: 0,
								stdout: 'Logged in using personal access token\n',
								stderr: '',
							};
						}
						return { ok: true, exitCode: 0, stdout: 'codex 0.12.0\n', stderr: '' };
					}
					return { ok: true, exitCode: 0, stdout: 'v1.0.0\n', stderr: '' };
				});

			const mockFs: ExecutableFileSystem = {
				stat: async (p) => {
					const norm = p.replaceAll('\\', '/');
					if (norm === '/usr/local/bin/codex' || norm === '/usr/local/bin/claude') {
						return createMockFileStat(true, false, 1000, 2048);
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				lstat: async (p) => {
					const norm = p.replaceAll('\\', '/');
					if (norm === '/usr/local/bin/codex' || norm === '/usr/local/bin/claude') {
						return createMockFileStat(true, false);
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				realpath: async (p) => p,
				access: async () => undefined,
				readlink: async (p) => p,
			};

			const service = createAgentService({
				registry,
				hostInputs: { platform: 'linux', homedir: '/test/data' },
				bus,
				envelopeFactory,
				fileSystem: mockFs,
				commandRunner: runner,
				clock: { now: () => '2026-09-12T02:00:00.000Z' },
			});

			await service.start();
			return { service, bus };
		}

		it('AC 7 & E-355: before first probe, non-dsh agent login is {state: unknown, reason: not_probed, checkedAt: null, loginCommand}', async () => {
			const { service } = await createTestAgentService();
			// Before probing, getLogin returns not_probed
			const login = service.getLogin('codex');
			expect(login).toEqual({
				state: 'unknown',
				reason: 'not_probed',
				checkedAt: null,
				loginCommand: 'codex login',
				warningCode: null,
			});

			// dsh returns null
			const dshLogin = service.getLogin('dsh');
			expect(dshLogin).toBeNull();
		});

		it('AC 7: AgentEntryDto top-level does NOT contain loginCommandHint', async () => {
			const { service } = await createTestAgentService();
			const agents = await service.listAgents();
			const codex = agents.find((a) => a.id === 'codex');
			expect(codex).toBeDefined();
			expect(codex?.login?.loginCommand).toBe('codex login');
			expect((codex as unknown as Record<string, unknown>).loginCommandHint).toBeUndefined();
		});

		it('AC 4 & E-336: assertCanDispatch() does NOT reject when login state is logged_out or unknown', async () => {
			const { service } = await createTestAgentService();
			// Probe claude which returns logged_out
			await service.probeAgent('claude');
			const login = service.getLogin('claude');
			expect(login?.state).toBe('logged_out');

			// assertCanDispatch must not throw
			await expect(service.assertCanDispatch('claude')).resolves.toBeUndefined();
		});

		it('AC 5: concurrent refreshLogin() calls deduplicate via inflightLogin', async () => {
			let runnerCallCount = 0;
			const { service } = await createTestAgentService(async (params) => {
				if (params.args.includes('login')) {
					runnerCallCount++;
					await new Promise((r) => setTimeout(r, 50));
					return {
						ok: true,
						exitCode: 0,
						stdout: 'Logged in using personal access token\n',
						stderr: '',
					};
				}
				return { ok: true, exitCode: 0, stdout: 'codex 0.12.0\n', stderr: '' };
			});

			await service.probeAgent('codex');
			runnerCallCount = 0;

			// Call refreshLogin concurrently twice
			const [res1, res2] = await Promise.all([
				service.refreshLogin('codex'),
				service.refreshLogin('codex'),
			]);

			expect(runnerCallCount).toBe(1);
			expect(res1?.state).toBe('logged_in');
			expect(res2?.state).toBe('logged_in');
		});

		it('AC 5: publishes agent.availability_changed with reason: login_changed upon completion', async () => {
			const { service, bus } = await createTestAgentService();
			const events: unknown[] = [];
			bus.subscribe((envelope) => {
				if (
					envelope.kind === 'agent.availability_changed' &&
					!('truncated' in envelope.payload) &&
					envelope.payload.reason === 'login_changed'
				) {
					events.push(envelope.payload);
				}
			});

			await service.refreshLogin('codex');
			expect(events.length).toBeGreaterThan(0);
			const lastPayload = events[events.length - 1] as {
				reason: string;
				agentId: string;
				login: { state: string };
			};
			expect(lastPayload.reason).toBe('login_changed');
			expect(lastPayload.agentId).toBe('codex');
			expect(lastPayload.login.state).toBe('logged_in');
		});

		it('AC 5: four invalidation points invalidate and refresh loginCache', async () => {
			let runnerCallCount = 0;
			const { service } = await createTestAgentService(async (params) => {
				if (params.args.includes('login')) {
					runnerCallCount++;
					return {
						ok: true,
						exitCode: 0,
						stdout: 'Logged in using personal access token\n',
						stderr: '',
					};
				}
				return { ok: true, exitCode: 0, stdout: 'codex 0.12.0\n', stderr: '' };
			});

			// Invalidation 1: POST /agents/:id/probe (probeAgent)
			await service.probeAgent('codex');
			expect(runnerCallCount).toBe(1);

			// Invalidation 2: GET /agents/:id/models?refresh=1
			await service.listAgentModels('codex', { refresh: true });
			// Allow microtask to settle
			await new Promise((r) => setTimeout(r, 10));
			expect(runnerCallCount).toBe(2);

			// Invalidation 3: refreshLogin with exited_before_output trigger
			await service.refreshLogin('codex', { trigger: 'exited_before_output' });
			expect(runnerCallCount).toBe(3);

			// Invalidation 4: availability flip
			// Updating agent to non-existent executable triggers availability change
			try {
				await service.updateAgent('codex', { maxConcurrency: 2 });
			} catch {
				// ignore
			}
			expect(runnerCallCount).toBeGreaterThanOrEqual(4);
		});
	});
});
