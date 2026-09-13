import { describe, expect, it, vi } from 'vitest';
import {
	createConnectionUiController,
	generateConnectionFailedHtml,
} from '../src/connection-ui.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';

describe('desktop connection-ui (AC 2, E-146)', () => {
	const spec = resolveLaunchSpec({
		currentExe: '/opt/scheduler/bin/scheduler',
		resourceDir: '/opt/scheduler/lib',
		hostPlatform: 'linux',
	});

	it('starts in idle state', () => {
		const controller = createConnectionUiController(spec);
		expect(controller.getState().status).toBe('idle');
	});

	it('transitions to started upon successful process launch', async () => {
		const mockLauncher = vi.fn().mockReturnValue({
			success: true,
			pid: 9999,
		});

		const controller = createConnectionUiController(spec, mockLauncher);
		const result = await controller.startDaemon();

		expect(result.success).toBe(true);
		expect(mockLauncher).toHaveBeenCalledWith(spec);
		expect(controller.getState().status).toBe('started');
		expect(controller.getState().pid).toBe(9999);
	});

	it('transitions to failed upon process launch error without retrying', async () => {
		const mockLauncher = vi.fn().mockReturnValue({
			success: false,
			error: 'Permission denied',
		});

		const controller = createConnectionUiController(spec, mockLauncher);
		const result = await controller.startDaemon();

		expect(result.success).toBe(false);
		expect(mockLauncher).toHaveBeenCalledTimes(1);
		expect(controller.getState().status).toBe('failed');
		expect(controller.getState().errorMessage).toBe('Permission denied');
	});

	it('generates connection failed fallback HTML with executable path and start button', () => {
		const html = generateConnectionFailedHtml({
			baseUrl: 'http://127.0.0.1:7817',
			spec,
		});

		expect(html).toContain('http://127.0.0.1:7817');
		expect(html).toContain('/opt/scheduler/lib/daemon');
		expect(html).toContain('<button id="start-btn">Start Daemon</button>');
	});
});
