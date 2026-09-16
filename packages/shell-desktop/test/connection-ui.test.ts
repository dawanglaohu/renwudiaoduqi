import { describe, expect, it, vi } from 'vitest';
import {
	createConnectionUiController,
	generateConnectionFailedHtml,
} from '../src/connection-ui.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';

describe('desktop connection-ui (AC 2, E-146, R8)', () => {
	const spec = resolveLaunchSpec({
		currentExe: '/opt/scheduler/bin/scheduler',
		resourceDir: '/opt/scheduler/lib',
		hostPlatform: 'linux',
	});

	it('starts in idle state and exposes the launch spec (R4)', () => {
		const controller = createConnectionUiController(spec);
		expect(controller.getState().status).toBe('idle');
		expect(controller.spec).toBe(spec);
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

	it('generates connection failed fallback HTML without hardcoded port (R8)', () => {
		const htmlDefault = generateConnectionFailedHtml({
			spec,
		});

		expect(htmlDefault).not.toContain('127.0.0.1:7817');
		expect(htmlDefault).toContain('/opt/scheduler/lib/daemon-runtime/runtime/node');
		expect(htmlDefault).toContain('<button id="start-btn">Start Daemon</button>');
		expect(htmlDefault).toContain('var(--bg)');
		expect(htmlDefault).toContain('var(--accent)');

		// When custom baseUrl is provided, it is reflected
		const htmlCustom = generateConnectionFailedHtml({
			baseUrl: 'http://custom-host:9000',
			spec,
		});
		expect(htmlCustom).toContain('http://custom-host:9000');
	});
});
