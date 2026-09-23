/**
 * Shell bridge contract (07-前端架构 / M10-T1).
 *
 * Web UI accesses native shell containers solely through this bridge contract.
 * The shell has zero knowledge of domain or business logic (task, run, gate, batch, agent).
 *
 * Exactly four capabilities (the fourth was added by the 2026-09-19 wiring audit, 决策 135):
 *   1. tokenStore: get / set / clear
 *   2. notify: { title, body, deepLink }
 *   3. hostHint: ()
 *   4. launchService(): only on tauri; resolves { pid } of the spawned local service
 * Plus two read-only properties:
 *   - platform: 'browser' | 'tauri' | 'capacitor'
 *   - capabilities: { hasSecureStorage, hasNativeNotification, canLaunchService }
 *
 * Adding a fifth capability requires amending development documentation first (07-前端架构 / AC 1).
 */

/**
 * Runtime host platform for the client application.
 * - 'browser': Direct browser access without a native shell container (E-200).
 * - 'tauri': Tauri v2 desktop shell (Windows, macOS, Linux).
 * - 'capacitor': Capacitor mobile shell (Android).
 */
export type ShellPlatform = 'browser' | 'tauri' | 'capacitor';

/**
 * Read-only capability flags exposed by the shell.
 * UI entries query these flags to disable or hide features (E-117, E-229).
 */
export interface ShellCapabilities {
	readonly hasSecureStorage: boolean;
	readonly hasNativeNotification: boolean;
	/**
	 * True only on tauri: the desktop container can spawn the local scheduler service.
	 * Browser and Capacitor hosts never can (E-146, E-200), so the UI hides the entry
	 * instead of offering an action that would fail.
	 */
	readonly canLaunchService: boolean;
}

/**
 * Token storage capability.
 * Shell mode stores client tokens in native secure storage (Keychain / Preferences).
 * Browser fallback uses sessionStorage ('agsched.token'); writing to localStorage is forbidden.
 */
export interface ShellTokenStore {
	get(): Promise<string | null>;
	set(token: string): Promise<void>;
	clear(): Promise<void>;
}

/**
 * Options for sending notifications.
 * Notification click must deliver deepLink (#/run/<runId>) to the web view.
 */
export interface ShellNotificationOptions {
	title: string;
	body?: string;
	deepLink?: string;
}

/**
 * Result of `ShellBridge.launchService()`: the pid of the process the shell spawned.
 * The shell spawns once and returns; it never retries and never probes the service
 * (E-146: no scheduling or retry policy lives in the container).
 */
export interface LaunchServiceResult {
	readonly pid: number;
}

/**
 * Unified shell bridge contract.
 * Constrained strictly to the four capabilities and two read-only properties.
 */
export interface ShellBridge {
	readonly platform: ShellPlatform;
	readonly capabilities: ShellCapabilities;
	readonly tokenStore: ShellTokenStore;
	notify(options: ShellNotificationOptions): Promise<void>;
	hostHint(): Promise<string | null>;
	/**
	 * Starts the local scheduler service from the frozen launch spec (E-146, E-04).
	 * Only implemented by the tauri adapter; every other host throws `E_SHELL_UNAVAILABLE`.
	 * Its only production call site is the 「启动调度服务」 action of
	 * `packages/web/src/app/connect-failed.tsx` (07-前端架构 / 决策 135).
	 */
	launchService(): Promise<LaunchServiceResult>;
}
