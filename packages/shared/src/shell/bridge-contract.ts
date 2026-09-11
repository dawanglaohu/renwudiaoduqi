/**
 * Shell bridge contract (07-前端架构 / M10-T1).
 *
 * Web UI accesses native shell containers solely through this bridge contract.
 * The shell has zero knowledge of domain or business logic (task, run, gate, batch, agent).
 *
 * Exactly three capabilities:
 *   1. tokenStore: get / set / clear
 *   2. notify: { title, body, deepLink }
 *   3. hostHint: ()
 * Plus two read-only properties:
 *   - platform: 'browser' | 'tauri' | 'capacitor'
 *   - capabilities: { hasSecureStorage, hasNativeNotification }
 *
 * Adding a fourth capability requires amending development documentation first (07-前端架构 / AC 1).
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
 * Unified shell bridge contract.
 * Constrained strictly to the three capabilities and two read-only properties.
 */
export interface ShellBridge {
	readonly platform: ShellPlatform;
	readonly capabilities: ShellCapabilities;
	readonly tokenStore: ShellTokenStore;
	notify(options: ShellNotificationOptions): Promise<void>;
	hostHint(): Promise<string | null>;
}
