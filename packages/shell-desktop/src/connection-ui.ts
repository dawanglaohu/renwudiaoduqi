import type { DaemonLaunchSpec } from '../../shared/src/shell/daemon-launch-spec.ts';
import { type LaunchDaemonResult, launchDaemon } from './daemon-process.ts';

export type ConnectionUiStatus = 'idle' | 'starting' | 'started' | 'failed';

export interface ConnectionUiState {
	readonly status: ConnectionUiStatus;
	readonly pid?: number;
	readonly errorMessage?: string;
}

export interface ConnectionUiController {
	getState(): ConnectionUiState;
	startDaemon(): Promise<LaunchDaemonResult>;
}

/**
 * Controller for the connection failure view in the desktop shell (AC 2, E-146).
 *
 * Requirements:
 * - Directly consumes the frozen DaemonLaunchSpec.
 * - Shell itself embeds ZERO scheduling or retry policies (single manual action).
 */
export function createConnectionUiController(
	spec: DaemonLaunchSpec,
	launcher?: (launchSpec: DaemonLaunchSpec) => LaunchDaemonResult,
): ConnectionUiController {
	let state: ConnectionUiState = Object.freeze({
		status: 'idle',
	});

	const executeLaunch = launcher ?? launchDaemon;

	return {
		getState(): ConnectionUiState {
			return state;
		},

		async startDaemon(): Promise<LaunchDaemonResult> {
			state = Object.freeze({
				status: 'starting',
			});

			const result = executeLaunch(spec);

			if (result.success) {
				state = Object.freeze({
					status: 'started',
					pid: result.pid,
				});
			} else {
				state = Object.freeze({
					status: 'failed',
					errorMessage: result.error ?? 'Failed to start daemon process',
				});
			}

			return result;
		},
	};
}

/**
 * Generates minimal fallback HTML for connection failure when daemon is unstarted (E-146).
 */
export function generateConnectionFailedHtml(options: {
	readonly baseUrl?: string;
	readonly spec: DaemonLaunchSpec;
}): string {
	const displayUrl = options.baseUrl ?? 'http://127.0.0.1:7817';
	const escapedFile = options.spec.file
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Service Unavailable</title>
  <style>
    body {
      background: #0F1213;
      color: #E9EEED;
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .panel {
      background: #171B1C;
      border: 1px solid rgba(214,232,229,.09);
      border-radius: 14px;
      padding: 24px;
      max-width: 480px;
      width: 100%;
    }
    h1 {
      font-size: 18px;
      margin: 0 0 12px;
      color: #F0B03C;
    }
    p {
      font-size: 13px;
      line-height: 1.5;
      color: #B2BCBB;
      margin: 0 0 16px;
    }
    .meta {
      font-size: 12px;
      font-family: monospace;
      color: #8B9695;
      margin-bottom: 20px;
      word-break: break-all;
    }
    button {
      background: #F0B03C;
      color: #171205;
      border: none;
      height: 32px;
      padding: 0 16px;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="panel">
    <h1>Service Not Running</h1>
    <p>The scheduler daemon is not running at ${displayUrl}.</p>
    <div class="meta">Executable: ${escapedFile}</div>
    <button id="start-btn">Start Daemon</button>
  </div>
</body>
</html>`;
}
