export const MANUAL_HOST_STORAGE_KEY = 'agsched.host' as const;

export type ShellHostHintProvider = () => Promise<string | null> | string | null;

let registeredShellHostHint: ShellHostHintProvider | null = null;

/**
 * Register a shell host hint provider (invoked by Tauri/Capacitor shell container wiring).
 */
export function registerShellHostHint(provider: ShellHostHintProvider | null): void {
	registeredShellHostHint = provider;
}

/**
 * Read user-entered manual host from localStorage (E-06 fallback).
 * Returns null if not set, empty, or if localStorage is unavailable.
 */
export function getManualHost(): string | null {
	if (typeof localStorage === 'undefined') {
		return null;
	}
	try {
		const value = localStorage.getItem(MANUAL_HOST_STORAGE_KEY);
		if (value?.trim()) {
			return value.trim();
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Persist user-entered manual host into localStorage (E-06 fallback).
 */
export function setManualHost(host: string): void {
	if (typeof localStorage === 'undefined') {
		return;
	}
	try {
		const trimmed = host.trim();
		if (trimmed) {
			localStorage.setItem(MANUAL_HOST_STORAGE_KEY, trimmed);
		} else {
			localStorage.removeItem(MANUAL_HOST_STORAGE_KEY);
		}
	} catch {
		// Ignore storage quota or security errors
	}
}

/**
 * Remove user-entered manual host from localStorage.
 */
export function clearManualHost(): void {
	if (typeof localStorage === 'undefined') {
		return;
	}
	try {
		localStorage.removeItem(MANUAL_HOST_STORAGE_KEY);
	} catch {
		// Ignore
	}
}

/**
 * Normalise baseUrl:
 *   - Trims whitespace
 *   - Prepends http:// if protocol is missing
 *   - Strips all trailing slashes
 */
export function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) {
		return '';
	}
	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	return withProtocol.replace(/\/+$/, '');
}

export interface ResolveBaseUrlOptions {
	shellHostHint?: ShellHostHintProvider;
	manualHost?: string | null;
	origin?: string | null;
}

/**
 * Three-level runtime baseUrl discovery (07-前端架构 / AC 2 / E-06):
 * Level 1: 壳注入 (Shell injected hostHint)
 * Level 2: 用户手填 (User manual input stored in localStorage `agsched.host`)
 * Level 3: location.origin (Browser origin)
 *
 * Strictly prohibits build-time constants or host/port in import.meta.env.
 */
export async function resolveBaseUrl(options?: ResolveBaseUrlOptions): Promise<string> {
	// Level 1: 壳注入
	const hintProvider = options?.shellHostHint ?? registeredShellHostHint;
	if (hintProvider) {
		const hint = await hintProvider();
		if (hint?.trim()) {
			return normalizeBaseUrl(hint);
		}
	}

	// Level 2: 用户手填 (E-06 manual host fallback)
	const manualHost = options?.manualHost !== undefined ? options.manualHost : getManualHost();
	if (manualHost?.trim()) {
		return normalizeBaseUrl(manualHost);
	}

	// Level 3: location.origin
	const origin =
		options?.origin !== undefined
			? options.origin
			: typeof window !== 'undefined' && window.location?.origin
				? window.location.origin
				: '';
	if (origin?.trim() && origin !== 'null') {
		return normalizeBaseUrl(origin);
	}

	return '';
}
