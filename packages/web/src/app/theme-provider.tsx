import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';

export type Theme = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeContextValue {
	theme: Theme;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = 'theme';

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Pure resolver: maps user theme setting to actual dark/light theme (E-15).
 * NEVER returns 'system'—system is strictly resolved to 'dark' or 'light'.
 */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
	if (theme === 'system') {
		return prefersDark ? 'dark' : 'light';
	}
	return theme;
}

/**
 * Applies the resolved theme to the <html> document root (E-15).
 * Only 'dark' or 'light' is written to data-theme and colorScheme.
 * Never locks root font-size, never sets text-size-adjust: none, never zooms.
 */
export function applyThemeToDocument(resolvedTheme: ResolvedTheme): void {
	if (typeof document === 'undefined') {
		return;
	}
	const root = document.documentElement;
	root.setAttribute('data-theme', resolvedTheme);
	root.style.colorScheme = resolvedTheme;
}

function getSystemPrefersDark(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return true; // default to dark in non-browser or fallback
	}
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getStoredTheme(): Theme {
	if (typeof window === 'undefined') {
		return 'system';
	}
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'dark' || stored === 'light' || stored === 'system') {
			return stored;
		}
	} catch {
		// localStorage might be unavailable or restricted
	}
	return 'system';
}

function setStoredTheme(theme: Theme): void {
	if (typeof window === 'undefined') {
		return;
	}
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Ignore storage write failures
	}
}

export interface ThemeProviderProps {
	children: ReactNode;
	defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme }: ThemeProviderProps) {
	const [theme, setThemeState] = useState<Theme>(() => defaultTheme ?? getStoredTheme());
	const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(getSystemPrefersDark);

	// Resolve the active visual theme
	const resolvedTheme = useMemo(
		() => resolveTheme(theme, systemPrefersDark),
		[theme, systemPrefersDark],
	);

	// Synchronize DOM attributes whenever resolvedTheme changes
	useEffect(() => {
		applyThemeToDocument(resolvedTheme);
	}, [resolvedTheme]);

	// Listen for system color-scheme changes when in 'system' mode
	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return;
		}

		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		const handler = (event: MediaQueryListEvent | MediaQueryList) => {
			setSystemPrefersDark(event.matches);
		};

		// Modern browsers
		if (typeof mediaQuery.addEventListener === 'function') {
			mediaQuery.addEventListener('change', handler);
			return () => {
				mediaQuery.removeEventListener('change', handler);
			};
		}

		// Fallback for older WebViews
		if (typeof mediaQuery.addListener === 'function') {
			mediaQuery.addListener(handler);
			return () => {
				mediaQuery.removeListener(handler);
			};
		}
	}, []);

	const setTheme = useCallback((nextTheme: Theme) => {
		setThemeState(nextTheme);
		setStoredTheme(nextTheme);
	}, []);

	const value = useMemo(
		() => ({
			theme,
			resolvedTheme,
			setTheme,
		}),
		[theme, resolvedTheme, setTheme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
}
