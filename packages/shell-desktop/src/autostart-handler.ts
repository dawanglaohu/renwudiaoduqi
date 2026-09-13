import type { DaemonLaunchSpec } from '../../shared/src/shell/daemon-launch-spec.ts';

export interface AutostartStatusInfo {
	readonly supported: boolean;
	readonly registered: boolean;
	readonly matchesSpec: boolean;
	readonly recordedSpec?: DaemonLaunchSpec;
	readonly manualStartCommand?: string;
}

export interface AutostartAdapterBridge {
	readonly register: (
		spec: DaemonLaunchSpec,
	) => Promise<{ readonly ok: boolean; readonly error?: unknown }>;
	readonly status: (spec: DaemonLaunchSpec) => Promise<{
		readonly ok: boolean;
		readonly value?: AutostartStatusInfo;
		readonly error?: unknown;
	}>;
	readonly manualStartCommand: (spec: DaemonLaunchSpec) => string;
}

export interface AutostartPreferenceStore {
	getNeverAskAgain(): boolean;
	setNeverAskAgain(value: boolean): void;
	getWasPreviouslyConfigured(): boolean;
	setWasPreviouslyConfigured(value: boolean): void;
}

export type AutostartPromptDecision = 're_register' | 'dismiss' | 'never_ask';

export interface SyncAutostartOptions {
	readonly adapter: AutostartAdapterBridge;
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
 * - Field-by-field verification rewrites when paths differ (E-209).
 * - Registration failure is non-fatal: degrades to copyable manual start command (E-210).
 * - When user manually disables autostart in OS: detects and prompts, never silently re-registers,
 *   honors "do not ask again" (E-208).
 */
export async function syncDesktopAutostart(
	options: SyncAutostartOptions,
): Promise<SyncAutostartOutcome> {
	const { adapter, spec } = options;
	const store = options.store ?? new MemoryAutostartPreferenceStore();

	const statusResult = await adapter.status(spec);
	if (!statusResult.ok || !statusResult.value?.supported) {
		return Object.freeze({
			outcome: 'unsupported',
			registered: false,
		});
	}

	const status = statusResult.value;

	// Case 1: Already registered and paths match identically
	if (status.registered && status.matchesSpec) {
		store.setWasPreviouslyConfigured(true);
		return Object.freeze({
			outcome: 'unchanged',
			registered: true,
		});
	}

	// Case 2: Registered, but launch spec paths differ (e.g. upgraded or moved) (E-209)
	if (status.registered && !status.matchesSpec) {
		const rewriteResult = await adapter.register(spec);
		if (rewriteResult.ok) {
			store.setWasPreviouslyConfigured(true);
			return Object.freeze({
				outcome: 'rewritten',
				registered: true,
			});
		}
		// Non-fatal failure degradation (E-210)
		return Object.freeze({
			outcome: 'failed',
			registered: false,
			manualCommand: adapter.manualStartCommand(spec),
			error: rewriteResult.error,
		});
	}

	// Case 3: Not registered, but was previously enabled (User disabled it in OS settings) (E-208)
	if (!status.registered && store.getWasPreviouslyConfigured()) {
		if (store.getNeverAskAgain()) {
			return Object.freeze({
				outcome: 'disabled_silenced',
				registered: false,
			});
		}

		if (options.promptUser) {
			const decision = await options.promptUser({
				title: 'System Autostart Entry Disabled',
				message:
					'The scheduler autostart entry was disabled in system settings. Would you like to re-enable it?',
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
				const regResult = await adapter.register(spec);
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
					manualCommand: adapter.manualStartCommand(spec),
					error: regResult.error,
				});
			}
		}

		// If no prompt function was provided, default to not silently re-registering
		return Object.freeze({
			outcome: 'dismissed',
			registered: false,
		});
	}

	// Case 4: First-time setup / initial registration
	const initialRegResult = await adapter.register(spec);
	if (initialRegResult.ok) {
		store.setWasPreviouslyConfigured(true);
		return Object.freeze({
			outcome: 'registered',
			registered: true,
		});
	}

	// Non-fatal registration rejection (E-210)
	return Object.freeze({
		outcome: 'failed',
		registered: false,
		manualCommand: adapter.manualStartCommand(spec),
		error: initialRegResult.error,
	});
}
