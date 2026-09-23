import type {
	ShellCapabilities,
	ShellPlatform,
} from '@agent-scheduler/shared/shell/bridge-contract';

export interface DetectedShell {
	readonly platform: ShellPlatform;
	readonly capabilities: ShellCapabilities;
}

interface ShellWindow {
	__TAURI_INTERNALS__?: unknown;
	Capacitor?: {
		isNativePlatform?: () => boolean;
	};
}

/**
 * Synchronous capability detection (07-前端架构 / AC 2).
 * Reads two globals synchronously:
 *   1. window.__TAURI_INTERNALS__ exists -> 'tauri'
 *   2. window.Capacitor?.isNativePlatform?.() === true -> 'capacitor'
 *   3. otherwise -> 'browser'
 *
 * Rules:
 *   - Prohibited from using userAgent
 *   - Prohibited from using try/catch
 *   - Prohibited from re-probing during rendering
 */
export function detectShell(win?: unknown): DetectedShell {
	const currentWindow =
		win !== undefined
			? (win as ShellWindow | null | undefined)
			: typeof window !== 'undefined'
				? (window as unknown as ShellWindow)
				: undefined;

	let platform: ShellPlatform = 'browser';

	if (currentWindow?.__TAURI_INTERNALS__ !== undefined) {
		platform = 'tauri';
	} else if (currentWindow?.Capacitor?.isNativePlatform?.() === true) {
		platform = 'capacitor';
	}

	const hasNative = platform !== 'browser';

	// Only the desktop container can spawn the local scheduler service (E-146, E-200):
	// the browser has nothing to start it with and Android has no daemon of its own.
	return Object.freeze({
		platform,
		capabilities: Object.freeze({
			hasSecureStorage: hasNative,
			hasNativeNotification: hasNative,
			canLaunchService: platform === 'tauri',
		}),
	});
}

/**
 * Frozen module-level shell capability state.
 * Evaluated once upon module load and remains immutable for the application lifetime.
 */
export const SHELL: DetectedShell = detectShell();
