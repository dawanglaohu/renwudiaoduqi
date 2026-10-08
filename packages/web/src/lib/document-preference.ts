function readPreferences(): Record<string, unknown> {
	try {
		const raw = localStorage.getItem('agsched.ui.v1');
		const value: unknown = raw ? JSON.parse(raw) : null;
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function readLastDocumentId(): string | null {
	const id = readPreferences().lastDocId;
	return typeof id === 'string' && id ? id : null;
}

export function rememberDocumentId(docId: string): void {
	try {
		localStorage.setItem(
			'agsched.ui.v1',
			JSON.stringify({ ...readPreferences(), lastDocId: docId }),
		);
	} catch {
		// The selection remains usable in memory when browser storage is unavailable.
	}
}
