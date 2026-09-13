import type {
	LoginState,
	LoginStatusState,
	LoginUnknownReason,
	ProviderLoginState,
} from '@agent-scheduler/shared/api/agents';
import type { AgentConfig, LoginProbeParser, ResolvedAgentConfig } from '../config/defaults.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import type { spawnManaged } from '../proc/spawn.ts';
import { isGrokAuthError } from './grok/login-patterns.ts';
import {
	type CommandRunnerParams,
	type CommandRunnerResult,
	DEFAULT_PROBE_TIMEOUT_MS,
	executeProbeProcess,
} from './probe.ts';

export interface ParseLoginOutputParams {
	readonly parser: LoginProbeParser;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut?: boolean;
	readonly loggedInPattern?: string | null;
	readonly loggedOutPattern?: string | null;
}

export interface ParsedLoginOutput {
	readonly state: LoginStatusState;
	readonly reason: LoginUnknownReason | null;
	readonly warningCode: 'E_AGENT_LOGIN_PROBE_FAILED' | null;
	readonly vendor?: string;
}

export function parseLoginOutput(params: ParseLoginOutputParams): ParsedLoginOutput {
	const { parser, stdout, stderr, exitCode, timedOut, loggedInPattern, loggedOutPattern } = params;

	if (parser === 'none') {
		return Object.freeze({
			state: 'unknown',
			reason: 'not_supported',
			warningCode: null,
		});
	}

	if (timedOut) {
		return Object.freeze({
			state: 'unknown',
			reason: 'timeout',
			warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
		});
	}

	if (exitCode === null) {
		return Object.freeze({
			state: 'unknown',
			reason: 'spawn_failed',
			warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
		});
	}

	switch (parser) {
		case 'codex_login_status': {
			if (exitCode === 0) {
				if (loggedInPattern) {
					try {
						const regex = new RegExp(loggedInPattern, 'i');
						if (regex.test(stdout)) {
							return Object.freeze({
								state: 'logged_in',
								reason: null,
								warningCode: null,
							});
						}
					} catch {
						// Invalid pattern regex
					}
				}
				if (loggedOutPattern) {
					try {
						const regex = new RegExp(loggedOutPattern, 'i');
						if (regex.test(stdout)) {
							return Object.freeze({
								state: 'logged_out',
								reason: null,
								warningCode: null,
							});
						}
					} catch {
						// Invalid pattern regex
					}
				}
				return Object.freeze({
					state: 'unknown',
					reason: 'unparsable',
					warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
				});
			}

			// Non-zero exit code: check if matches loggedOutPattern
			if (loggedOutPattern) {
				try {
					const regex = new RegExp(loggedOutPattern, 'i');
					if (regex.test(stdout) || regex.test(stderr)) {
						return Object.freeze({
							state: 'logged_out',
							reason: null,
							warningCode: null,
						});
					}
				} catch {
					// Invalid pattern regex
				}
			}

			return Object.freeze({
				state: 'unknown',
				reason: 'exit_nonzero',
				warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
			});
		}

		case 'claude_auth_json': {
			let parsedJson: Record<string, unknown> | null = null;
			try {
				parsedJson = JSON.parse(stdout.trim());
			} catch {
				const match = stdout.match(/\{[\s\S]*\}/);
				if (match) {
					try {
						parsedJson = JSON.parse(match[0]);
					} catch {
						parsedJson = null;
					}
				}
			}

			if (
				parsedJson !== null &&
				typeof parsedJson === 'object' &&
				typeof parsedJson.loggedIn === 'boolean'
			) {
				const vendor =
					typeof parsedJson.apiProvider === 'string' ? parsedJson.apiProvider : undefined;
				return Object.freeze({
					state: parsedJson.loggedIn ? 'logged_in' : 'logged_out',
					reason: null,
					warningCode: null,
					vendor,
				});
			}

			if (exitCode !== 0) {
				return Object.freeze({
					state: 'unknown',
					reason: 'exit_nonzero',
					warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
				});
			}

			return Object.freeze({
				state: 'unknown',
				reason: 'unparsable',
				warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
			});
		}

		case 'grok_models_exit': {
			if (exitCode === 0) {
				return Object.freeze({
					state: 'logged_in',
					reason: null,
					warningCode: null,
				});
			}

			if (isGrokAuthError(stderr) || isGrokAuthError(stdout)) {
				return Object.freeze({
					state: 'logged_out',
					reason: null,
					warningCode: null,
				});
			}

			return Object.freeze({
				state: 'unknown',
				reason: 'exit_nonzero',
				warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
			});
		}

		case 'pi_auth_check': {
			let parsedJson: Record<string, unknown> | null = null;
			try {
				parsedJson = JSON.parse(stdout.trim());
			} catch {
				const match = stdout.match(/\{[\s\S]*\}/);
				if (match) {
					try {
						parsedJson = JSON.parse(match[0]);
					} catch {
						parsedJson = null;
					}
				}
			}

			if (parsedJson !== null && typeof parsedJson === 'object') {
				const status = parsedJson.status;
				if (status === 'ready') {
					return Object.freeze({
						state: 'logged_in',
						reason: null,
						warningCode: null,
					});
				}
				if (status === 'not_ready') {
					return Object.freeze({
						state: 'logged_out',
						reason: null,
						warningCode: null,
					});
				}
				if (status === 'invalid') {
					return Object.freeze({
						state: 'unknown',
						reason: 'unparsable',
						warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
					});
				}
				return Object.freeze({
					state: 'unknown',
					reason: 'unparsable',
					warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
				});
			}

			if (exitCode !== 0) {
				return Object.freeze({
					state: 'unknown',
					reason: 'exit_nonzero',
					warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
				});
			}

			return Object.freeze({
				state: 'unknown',
				reason: 'unparsable',
				warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
			});
		}
	}
}

export interface ProbeLoginOptions {
	readonly agentId: string;
	readonly config: AgentConfig | ResolvedAgentConfig;
	readonly resolvedPath?: string | null;
	readonly homedir?: string;
	readonly platform?: SupportedPlatform;
	readonly timeoutMs?: number;
	readonly providers?: readonly string[];
	readonly defaultProvider?: string | null;
	readonly commandRunner?: (params: CommandRunnerParams) => Promise<CommandRunnerResult>;
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly nowIso?: string;
}

export async function probeLogin(options: ProbeLoginOptions): Promise<LoginState | null> {
	const { config, agentId } = options;
	const parser = config.loginProbe.parser;
	const now = options.nowIso ?? new Date().toISOString();
	const commandHint = config.loginProbe.loginCommandHint ?? null;

	// AC 3: parser='none' (dsh) does not start process, does not write cache, DTO login is null
	if (parser === 'none') {
		return null;
	}

	// AC 2: If resolvedPath is empty, return unknown/exec_missing without starting process
	if (!options.resolvedPath || options.resolvedPath.trim().length === 0) {
		return Object.freeze({
			state: 'unknown',
			reason: 'exec_missing',
			checkedAt: now,
			loginCommand: commandHint,
			warningCode: null,
		});
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const platform = options.platform ?? 'linux';
	const cwd = options.homedir && options.homedir.length > 0 ? options.homedir : '.';

	// AC 3 & E-349: Pi probes providers in parallel
	if (parser === 'pi_auth_check') {
		const rawProviders =
			options.providers && options.providers.length > 0
				? options.providers
				: options.defaultProvider
					? [options.defaultProvider]
					: [];

		if (rawProviders.length === 0) {
			return Object.freeze({
				state: 'unknown',
				reason: 'no_provider',
				checkedAt: now,
				loginCommand: null,
				warningCode: null,
			});
		}

		// Deduplicate provider list
		const distinctProviders: string[] = [];
		for (const p of rawProviders) {
			if (!distinctProviders.includes(p)) {
				distinctProviders.push(p);
			}
		}

		const probedProviders = distinctProviders.slice(0, 10);
		const excessProviders = distinctProviders.slice(10);

		const probePromises = probedProviders.map(async (provider) => {
			const args = config.loginProbe.args.map((arg) => arg.replaceAll('{provider}', provider));
			const exec = await executeProbeProcess({
				file: options.resolvedPath as string,
				args,
				windowsVerbatimArguments: false,
				cwd,
				timeoutMs,
				platform,
				commandRunner: options.commandRunner,
				spawnManagedFn: options.spawnManagedFn,
				agentId,
			});

			const parsed = parseLoginOutput({
				parser: 'pi_auth_check',
				stdout: exec.stdout,
				stderr: exec.stderr,
				exitCode: exec.exitCode,
				timedOut: exec.timedOut,
			});

			return { provider, parsed };
		});

		const probeResults = await Promise.all(probePromises);

		const providersMap: Record<string, ProviderLoginState> = {};
		for (const { provider, parsed } of probeResults) {
			providersMap[provider] = Object.freeze({
				state: parsed.state,
				reason: parsed.reason,
			});
		}
		for (const provider of excessProviders) {
			providersMap[provider] = Object.freeze({
				state: 'unknown',
				reason: 'not_probed',
			});
		}

		// AC 3 & E-349: agent-level state takes defaultProvider item, default takes first logged_in, else unknown
		let agentState: LoginStatusState = 'unknown';
		let agentReason: LoginUnknownReason | null = null;

		if (options.defaultProvider && providersMap[options.defaultProvider]) {
			const target = providersMap[options.defaultProvider];
			if (target) {
				agentState = target.state;
				agentReason = target.reason;
			}
		} else {
			const firstLoggedIn = distinctProviders.find((p) => providersMap[p]?.state === 'logged_in');
			if (firstLoggedIn) {
				agentState = 'logged_in';
				agentReason = null;
			} else {
				agentState = 'unknown';
				const firstFailed = probedProviders.find((p) => providersMap[p]?.reason !== null);
				const target = firstFailed ? providersMap[firstFailed] : undefined;
				agentReason = target ? target.reason : 'unparsable';
			}
		}

		const warningCode =
			agentReason === 'timeout' ||
			agentReason === 'unparsable' ||
			agentReason === 'spawn_failed' ||
			agentReason === 'exit_nonzero'
				? 'E_AGENT_LOGIN_PROBE_FAILED'
				: null;

		return Object.freeze({
			state: agentState,
			reason: agentReason,
			checkedAt: now,
			loginCommand: null,
			warningCode,
			providers: Object.freeze(providersMap),
		});
	}

	// For codex_login_status, claude_auth_json, grok_models_exit
	const exec = await executeProbeProcess({
		file: options.resolvedPath,
		args: config.loginProbe.args,
		windowsVerbatimArguments: false,
		cwd,
		timeoutMs,
		platform,
		commandRunner: options.commandRunner,
		spawnManagedFn: options.spawnManagedFn,
		agentId,
	});

	const parsed = parseLoginOutput({
		parser,
		stdout: exec.stdout,
		stderr: exec.stderr,
		exitCode: exec.exitCode,
		timedOut: exec.timedOut,
		loggedInPattern: config.loginProbe.loggedInPattern,
		loggedOutPattern: config.loginProbe.loggedOutPattern,
	});

	return Object.freeze({
		state: parsed.state,
		reason: parsed.reason,
		checkedAt: now,
		loginCommand: commandHint,
		warningCode: parsed.warningCode,
		vendor: parsed.vendor,
	});
}
