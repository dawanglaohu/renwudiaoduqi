(() => {
	let theme = 'system';
	try {
		const stored = localStorage.getItem('theme');
		if (stored === 'dark' || stored === 'light' || stored === 'system') {
			theme = stored;
		}
	} catch {
		// Storage restrictions leave the system preference in effect.
	}
	const prefersDark =
		typeof window.matchMedia !== 'function' ||
		window.matchMedia('(prefers-color-scheme: dark)').matches;
	const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
	const root = document.documentElement;
	root.setAttribute('data-theme', resolved);
	root.style.colorScheme = resolved;
})();
