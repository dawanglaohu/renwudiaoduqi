import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	register as autostartRegister,
	status as autostartStatus,
} from '@agent-scheduler/daemon/boot/autostart';
import type { AutostartAdapter } from '@agent-scheduler/daemon/platform/autostart-contract';
import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';

export interface AutostartPreferenceStore {
	getNeverAskAgain(): boolean;
	setNeverAskAgain(value: boolean): void;
	getWasPreviouslyConfigured(): boolean;
	setWasPreviouslyConfigured(value: boolean): void;
}

export type AutostartPromptDecision = 're_register' | 'dismiss' | 'never_ask';

export interface SyncAutostartOptions {
	readonly adapter: AutostartAdapter;
	readonly spec: DaemonLaunchSpec;
	readonly store?: AutostartPreferenceStore;
	readonly promptUser?: (prompt: {
		readonly title: string;
		readonly message: string;
		readonly options: readonly ['re_register', 'dismiss', 'never_ask'];
	}) => Promise<AutostartPromptDecision>;
}

export type SyncAutostartOutcome =
	| { readonly outcome: 'unchanged'; readonly registered: true }
	| { readonly outcome: 'rewritten'; readonly registered: true }
	| { readonly outcome: 'registered'; readonly registered: true }
	| { readonly outcome: 're_registered'; readonly registered: true }
	| { readonly outcome: 'dismissed'; readonly registered: false }
	| { readonly outcome: 'disabled_silenced'; readonly registered: false }
	| { readonly outcome: 'unsupported'; readonly registered: false }
	| {
			readonly outcome: 'failed';
			readonly registered: boolean;
			readonly manualCommand: string;
			readonly error?: unknown;
	  };

function getDefaultPreferenceFilePath(): string {
	const baseDir = homedir() || '.';
	return join(baseDir, '.config', 'agsched-desktop', 'autostart-preference.json');
}

/**
 * File-backed persistent preference store (AC 5, E-208).
 * Ensures autostart preferences survive process restarts and prevents silent re-registration.
 */
export class FileAutostartPreferenceStore implements AutostartPreferenceStore {
	private readonly filePath: string;
	private state: { neverAskAgain: boolean; wasPreviouslyConfigured: boolean };

	constructor(customPath?: string) {
		this.filePath = customPath ?? getDefaultPreferenceFilePath();
		this.state = this.load();
	}

	private load(): { neverAskAgain: boolean; wasPreviouslyConfigured: boolean } {
		try {
			if (existsSync(this.filePath)) {
				const content = readFileSync(this.filePath, 'utf8');
				const parsed = JSON.parse(content);
				return {
					neverAskAgain: Boolean(parsed.neverAskAgain),
					wasPreviouslyConfigured: Boolean(parsed.wasPreviouslyConfigured),
				};
			}
		} catch {
			// fallback on corruption or filesystem error
		}
		return { neverAskAgain: false, wasPreviouslyConfigured: false };
	}

	private save(): void {
		try {
			const dir = dirname(this.filePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
		} catch {
			// ignore filesystem write errors
		}
	}

	getNeverAskAgain(): boolean {
		return this.state.neverAskAgain;
	}

	setNeverAskAgain(value: boolean): void {
		this.state.neverAskAgain = value;
		this.save();
	}

	getWasPreviouslyConfigured(): boolean {
		return this.state.wasPreviouslyConfigured;
	}

	setWasPreviouslyConfigured(value: boolean): void {
		this.state.wasPreviouslyConfigured = value;
		this.save();
	}
}

/**
 * In-memory fallback preference store retained exclusively for testing (AC 5).
 */
export class MemoryAutostartPreferenceStore implements AutostartPreferenceStore {
	private neverAsk = false;
	private previouslyConfigured = false;

	getNeverAskAgain(): boolean {
		return this.neverAsk;
	}
	setNeverAskAgain(value: boolean): void {
		this.neverAsk = value;
	}
	getWasPreviouslyConfigured(): boolean {
		return this.previouslyConfigured;
	}
	setWasPreviouslyConfigured(value: boolean): void {
		this.previouslyConfigured = value;
	}
}

/**
 * Coordinates native autostart registration, upgrades, and external disablement detection.
 *
 * Requirements (AC 4, AC 5, E-208, E-209, E-210):
 * - Passes identical frozen DaemonLaunchSpec to M1 autostart adapter.
 * - Delegates field-by-field verification, rewriting, and non-fatal errors to M1 (E-209, E-210).
 * - When user manually disables autostart in OS: detects and prompts, never silently re-registers,
 *   honors "do not ask again" (E-208).
 */
export async function syncDesktopAutostart(
	options: SyncAutostartOptions,
): Promise<SyncAutostartOutcome> {
	const { adapter, spec } = options;
	const store = options.store ?? new FileAutostartPreferenceStore();

	const statusResult = await autostartStatus(spec, adapter);
	if (!statusResult.ok) {
		return Object.freeze({
			outcome: 'unsupported',
			registered: false,
		});
	}

	const status = statusResult.value;

	// Case 1: User disabled in OS after prior configuration (E-208)
	if (!status.registered && store.getWasPreviouslyConfigured()) {
		if (store.getNeverAskAgain()) {
			return Object.freeze({
				outcome: 'disabled_silenced',
				registered: false,
			});
		}

		if (options.promptUser) {
			const decision = await options.promptUser({
				title: 'Autostart Disabled',
				message:
					'Background service autostart was disabled in system settings. Would you like to re-enable it?',
				options: ['re_register', 'dismiss', 'never_ask'],
			});

			if (decision === 'never_ask') {
				store.setNeverAskAgain(true);
				return Object.freeze({
					outcome: 'disabled_silenced',
					registered: false,
				});
			}

			if (decision === 'dismiss') {
				return Object.freeze({
					outcome: 'dismissed',
					registered: false,
				});
			}

			if (decision === 're_register') {
				const regResult = await autostartRegister(spec, adapter);
				if (regResult.ok) {
					store.setWasPreviouslyConfigured(true);
					return Object.freeze({
						outcome: 're_registered',
						registered: true,
					});
				}
				return Object.freeze({
					outcome: 'failed',
					registered: false,
					manualCommand: regResult.manualStartCommand ?? adapter.manualStartCommand(spec),
					error: regResult.error,
				});
			}
		}

		// When no prompt function is available, never silently re-register (E-208)
		return Object.freeze({
			outcome: 'dismissed',
			registered: false,
		});
	}

	// Case 2: Standard registration through M1 (idempotent, field comparison, rewrite on upgrade)
	const regResult = await autostartRegister(spec, adapter);
	if (regResult.ok) {
		store.setWasPreviouslyConfigured(true);
		if (regResult.rewritten) {
			return Object.freeze({
				outcome: 'rewritten',
				registered: true,
			});
		}
		if (status.registered && status.matchesSpec) {
			return Object.freeze({
				outcome: 'unchanged',
				registered: true,
			});
		}
		return Object.freeze({
			outcome: 'registered',
			registered: true,
		});
	}

	// Non-fatal registration failure (E-210)
	return Object.freeze({
		outcome: 'failed',
		registered: false,
		manualCommand: regResult.manualStartCommand ?? adapter.manualStartCommand(spec),
		error: regResult.error,
	});
}
