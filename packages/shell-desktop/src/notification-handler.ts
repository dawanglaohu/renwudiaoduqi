export interface WebviewNavigationTarget {
	location?: {
		hash: string;
	};
	eval?: (code: string) => void;
}

/**
 * Handles delivery of notification clicks to the WebView.
 *
 * Requirements (AC 6):
 * - Delivers target deepLink to WebView via location hash.
 * - Strictly avoids custom IPC protocols transmitting business data.
 */
export function deliverNotificationDeepLink(
	deepLink: string,
	targetWindow?: WebviewNavigationTarget,
): boolean {
	const trimmed = deepLink.trim();
	if (!trimmed) {
		return false;
	}

	const normalizedHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;

	const win =
		targetWindow ??
		(typeof window !== 'undefined' ? (window as unknown as WebviewNavigationTarget) : undefined);

	if (!win) {
		return false;
	}

	if (win.location) {
		win.location.hash = normalizedHash;
		return true;
	}

	if (typeof win.eval === 'function') {
		win.eval(`window.location.hash = ${JSON.stringify(normalizedHash)};`);
		return true;
	}

	return false;
}
