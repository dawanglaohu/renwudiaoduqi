// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EmptyOnboarding } from '../src/components/empty-onboarding.tsx';

describe('R13 onboarding dispatch availability', () => {
	it('E-12: offline dispatch is disabled even with selected batch and callback', () => {
		const html = renderToStaticMarkup(
			createElement(EmptyOnboarding, {
				currentStep: 3,
				selectedDocId: 'doc',
				selectedBatchId: 'batch',
				onDispatch: vi.fn(),
				canDispatch: false,
			}),
		);
		const root = document.createElement('div');
		root.innerHTML = html;
		expect(
			(root.querySelector('[data-action="confirm-dispatch"]') as HTMLButtonElement).disabled,
		).toBe(true);
	});
});
