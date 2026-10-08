// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EmptyOnboarding } from '../src/components/empty-onboarding.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

	it('submits explicit repository paths and offers rebinding the selected document', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		const onImportDocument = vi.fn();
		const onRebindDocument = vi.fn();
		try {
			await act(async () =>
				root.render(
					createElement(EmptyOnboarding, {
						currentStep: 0,
						selectedDocId: 'existing-document',
						onImportDocument,
						onRebindDocument,
					}),
				),
			);
			const write = async (label: string, value: string) => {
				const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
				expect(input).not.toBeNull();
				await act(async () => {
					Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
						input,
						value,
					);
					input?.dispatchEvent(new Event('input', { bubbles: true }));
				});
			};
			await write('文档路径', 'D:\\项目\\docs-data.js');
			await write('仓库目录', 'D:\\项目');
			const buttons = [...container.querySelectorAll('button')];
			await act(async () => buttons.find((button) => button.textContent === '导入文档')?.click());
			expect(onImportDocument).toHaveBeenCalledWith('D:\\项目\\docs-data.js', 'D:\\项目');
			await act(async () =>
				buttons.find((button) => button.textContent === '更新当前文档')?.click(),
			);
			expect(onRebindDocument).toHaveBeenCalledWith('D:\\项目\\docs-data.js', 'D:\\项目');
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
