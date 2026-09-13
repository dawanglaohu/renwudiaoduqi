import { describe, expect, it, vi } from 'vitest';
import { createBackButtonHandler } from '../src/back-button.ts';

describe('Android Hardware Back Button (AC 3, E-225)', () => {
	it('AC 3 & E-225: maps back button to history.back() when history exists, and NEVER exits immediately on first press', () => {
		const mockHistory = {
			back: vi.fn(),
			length: 3,
		};
		const mockApp = {
			exitApp: vi.fn(),
			addListener: vi.fn(),
		};
		const mockLocation = {
			hash: '#/tasks',
		};

		const handler = createBackButtonHandler({
			app: mockApp,
			history: mockHistory,
			location: mockLocation,
		});

		// User navigated to #/tasks (not at root bottom)
		handler.recordForwardNavigation();
		expect(handler.getStackDepth()).toBe(1);

		// Press back button 1st time: MUST call history.back(), MUST NOT exit app
		handler.handleBackPress({ canGoBack: true });

		expect(mockHistory.back).toHaveBeenCalledTimes(1);
		expect(mockApp.exitApp).not.toHaveBeenCalled();

		handler.destroy();
	});

	it('AC 3 & E-225: retreats through multiple pages and only exits when hash stack reaches root bottom (#/)', () => {
		const mockHistory = {
			back: vi.fn(),
		};
		const mockApp = {
			exitApp: vi.fn(),
		};
		const mockLocation = {
			hash: '#/run/run-42',
		};

		const handler = createBackButtonHandler({
			app: mockApp,
			history: mockHistory,
			location: mockLocation,
		});

		// Simulate navigation: #/ -> #/tasks -> #/run/run-42
		handler.recordForwardNavigation(); // to #/tasks
		handler.recordForwardNavigation(); // to #/run/run-42
		expect(handler.getStackDepth()).toBe(2);

		// Press 1: from #/run/run-42 -> back to #/tasks
		handler.handleBackPress({ canGoBack: true });
		expect(mockHistory.back).toHaveBeenCalledTimes(1);
		expect(mockApp.exitApp).not.toHaveBeenCalled();

		// Update location to #/tasks
		mockLocation.hash = '#/tasks';

		// Press 2: from #/tasks -> back to #/
		handler.handleBackPress({ canGoBack: true });
		expect(mockHistory.back).toHaveBeenCalledTimes(2);
		expect(mockApp.exitApp).not.toHaveBeenCalled();

		// Update location to #/ (root)
		mockLocation.hash = '#/';

		// Press 3: stack has reached bottom (depth = 0 and at #/)
		handler.handleBackPress({ canGoBack: false });
		expect(mockHistory.back).toHaveBeenCalledTimes(2); // no further history.back
		expect(mockApp.exitApp).toHaveBeenCalledTimes(1); // now allowed to exit

		handler.destroy();
	});

	it('invokes onBack and onExit callbacks respectively', () => {
		const onBack = vi.fn();
		const onExit = vi.fn();
		const mockHistory = { back: vi.fn() };
		const mockApp = { exitApp: vi.fn() };
		const mockLocation = { hash: '#/settings/agents' };

		const handler = createBackButtonHandler({
			app: mockApp,
			history: mockHistory,
			location: mockLocation,
			onBack,
			onExit,
		});

		handler.recordForwardNavigation();
		handler.handleBackPress({ canGoBack: true });
		expect(onBack).toHaveBeenCalledTimes(1);
		expect(onExit).not.toHaveBeenCalled();

		mockLocation.hash = '#/';
		handler.handleBackPress({ canGoBack: false });
		expect(onExit).toHaveBeenCalledTimes(1);

		handler.destroy();
	});
});
