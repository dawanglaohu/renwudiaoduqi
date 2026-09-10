import { describe, expect, it } from 'vitest';
import {
	type ResolvedTheme,
	applyThemeToDocument,
	resolveTheme,
} from '../src/app/theme-provider.js';

describe('theme-provider (M9-T1, E-15)', () => {
	it('resolves explicit dark and light modes correctly', () => {
		expect(resolveTheme('dark', false)).toBe('dark');
		expect(resolveTheme('dark', true)).toBe('dark');
		expect(resolveTheme('light', false)).toBe('light');
		expect(resolveTheme('light', true)).toBe('light');
	});

	it('resolves system mode based on prefersDark media query result (never returns system)', () => {
		expect(resolveTheme('system', true)).toBe('dark');
		expect(resolveTheme('system', false)).toBe('light');
		const resolved: ResolvedTheme = resolveTheme('system', false);
		expect(resolved).not.toBe('system');
	});

	it('applies resolved theme to document element data-theme and colorScheme (E-15)', () => {
		// Mock document root
		const attributes = new Map<string, string>();
		const mockElement = {
			setAttribute: (name: string, val: string) => {
				attributes.set(name, val);
			},
			getAttribute: (name: string) => attributes.get(name),
			style: {} as { colorScheme?: string },
		};

		const origDoc = globalThis.document;
		(globalThis as unknown as { document: unknown }).document = {
			documentElement: mockElement,
		};

		try {
			applyThemeToDocument('dark');
			expect(mockElement.getAttribute('data-theme')).toBe('dark');
			expect(mockElement.style.colorScheme).toBe('dark');

			applyThemeToDocument('light');
			expect(mockElement.getAttribute('data-theme')).toBe('light');
			expect(mockElement.style.colorScheme).toBe('light');
		} finally {
			globalThis.document = origDoc;
		}
	});
});
