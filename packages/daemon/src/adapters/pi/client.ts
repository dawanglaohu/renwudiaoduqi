import { AppError } from '../../errors/app-error.ts';
import { type LineReader, type ReadLine, createLineReader } from '../../proc/line-reader.ts';
import type { ManagedProcess } from '../../proc/spawn.ts';
import {
	type EventEnvelopeInput,
	type PiEventMappingTracker,
	createPiEventTracker,
	isKnownPiEventType,
	mapPiEvents,
} from './map-events.ts';

export interface PiImageContent {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
}

/**
 * Minimal verified RPC command subset per AC 3:
 * - prompt
 * - steer
 * - abort
 * - get_state
 */
export type PiRpcCommandType = 'prompt' | 'steer' | 'abort' | 'get_state';

export interface PiRpcCommandBase {
	readonly id?: string;
	readonly type: PiRpcCommandType;
}

export interface PiRpcPromptCommand extends PiRpcCommandBase {
	readonly type: 'prompt';
	readonly message: string;
	readonly images?: readonly PiImageContent[];
	readonly streamingBehavior?: 'steer' | 'followUp';
}

export interface PiRpcSteerCommand extends PiRpcCommandBase {
	readonly type: 'steer';
	readonly message: string;
	readonly images?: readonly PiImageContent[];
}

export interface PiRpcAbortCommand extends PiRpcCommandBase {
	readonly type: 'abort';
}

export interface PiRpcGetStateCommand extends PiRpcCommandBase {
	readonly type: 'get_state';
}

export type PiRpcCommand =
	| PiRpcPromptCommand
	| PiRpcSteerCommand
	| PiRpcAbortCommand
	| PiRpcGetStateCommand;

export interface PiRpcSessionState {
	readonly model?: Record<string, unknown>;
	readonly thinkingLevel?: string;
	readonly isStreaming?: boolean;
	readonly isCompacting?: boolean;
	readonly steeringMode?: string;
	readonly followUpMode?: string;
	readonly sessionFile?: string;
	readonly sessionId?: string;
	readonly sessionName?: string;
	readonly autoCompactionEnabled?: boolean;
	readonly messageCount?: number;
	readonly pendingMessageCount?: number;
	readonly [key: string]: unknown;
}

export interface PiRpcSuccessResponse<T = unknown> {
	readonly id?: string;
	readonly type: 'response';
	readonly command: string;
	readonly success: true;
	readonly data?: T;
}

export interface PiRpcErrorResponse {
	readonly id?: string;
	readonly type: 'response';
	readonly command: string;
	readonly success: false;
	readonly error: string;
}

export type PiRpcResponse<T = unknown> = PiRpcSuccessResponse<T> | PiRpcErrorResponse;

export interface PiRpcTransport {
	writeStdin(data: string | Buffer): boolean | undefined;
	onLine?(listener: (line: ReadLine) => void): () => void;
	onChunk?(listener: (chunk: Buffer) => void): () => void;
	onExit?(
		listener: (result: { exitCode: number | null; signal: string | null }) => void,
	): () => void;
}

export interface PiRpcClientOptions {
	readonly transport?: PiRpcTransport | ManagedProcess;
	readonly requestTimeoutMs?: number;
	readonly tracker?: PiEventMappingTracker;
	readonly runId?: string;
	readonly taskId?: string;
}

export interface PendingRequest {
	readonly command: PiRpcCommandType;
	readonly resolve: (response: PiRpcResponse) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export type PiEventListener = (event: Record<string, unknown>) => void;
export type PiEnvelopeListener = (envelope: EventEnvelopeInput) => void;

/**
 * Pi Native RPC Client.
 * Adheres strictly to M4-T10 requirements:
 * 1) Communicates via native RPC mode (`--mode rpc`) rather than third-party ACP bridge.
 * 2) Strictly disables Node `readline`, using M1-T7 LineReader (splitting only on 0x0A LF,
 *    accommodating U+2028 and U+2029 within valid JSON strings per E-203).
 * 3) Relies solely on the verified minimal command subset (prompt, steer, abort, get_state)
 *    and ignores unknown vendor event types gracefully with counter per E-202.
 * 4) Maps `agent_settled` to the run finished / completion signal and settles wait promises.
 */
export class PiRpcClient {
	private readonly transport?: PiRpcTransport | ManagedProcess;
	private readonly requestTimeoutMs: number;
	private readonly tracker: PiEventMappingTracker;
	private readonly stdoutLineReader: LineReader;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<PiEventListener>();
	private readonly envelopeListeners = new Set<PiEnvelopeListener>();
	private readonly unmappedListeners = new Set<(type: string, raw: unknown) => void>();
	private readonly settledResolvers = new Set<() => void>();
	private readonly cleanupFns: Array<() => void> = [];

	private requestSequence = 0;
	private _isSettled = false;
	private _isDisposed = false;
	private runId?: string;
	private taskId?: string;

	constructor(options: PiRpcClientOptions = {}) {
		this.transport = options.transport;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.tracker = options.tracker ?? createPiEventTracker();
		this.runId = options.runId;
		this.taskId = options.taskId;

		// AC 2: strictly use M1-T7 line reader, forbidding Node readline
		this.stdoutLineReader = createLineReader();

		this.bindTransport();
	}

	get isSettled(): boolean {
		return this._isSettled;
	}

	get isDisposed(): boolean {
		return this._isDisposed;
	}

	get unmappedEventCount(): number {
		return this.tracker.unmappedCount;
	}

	get unmappedEventTypes(): readonly string[] {
		return this.tracker.unmappedTypes;
	}

	/**
	 * Pushes raw stdout binary chunks into M1-T7 line reader (AC 2, E-203).
	 * Does not use Node readline. Handles U+2028 / U+2029 safely in JSON lines.
	 */
	pushChunk(chunk: Buffer): readonly ReadLine[] {
		const lines = this.stdoutLineReader.push(chunk);
		for (const line of lines) {
			this.handleLine(line.text);
		}
		return lines;
	}

	/**
	 * Flushes any remaining buffered text in the line reader.
	 */
	flush(): readonly ReadLine[] {
		const lines = this.stdoutLineReader.flush();
		for (const line of lines) {
			this.handleLine(line.text);
		}
		return lines;
	}

	/**
	 * Processes a single line of RPC text.
	 */
	handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			// E-140: Unparseable line is safely ignored by event mapper
			return;
		}

		if (!data || typeof data !== 'object') return;

		// 1. Check if it's a response to a pending command
		if (data.type === 'response' && typeof data.id === 'string') {
			const pending = this.pendingRequests.get(data.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(data.id);
				const resp = data as unknown as PiRpcResponse;
				if (resp.success) {
					pending.resolve(resp);
				} else {
					pending.reject(
						new AppError(
							'E_INTERNAL',
							`Pi RPC command '${pending.command}' failed: ${resp.error || 'unknown error'}`,
						),
					);
				}
				return;
			}
		}

		// 2. Dispatch event
		const eventType = typeof data.type === 'string' ? data.type : '';
		if (!eventType) return;

		// E-202: Unknown event handling
		if (!isKnownPiEventType(eventType)) {
			this.tracker.recordUnmapped(eventType, data);
			for (const listener of this.unmappedListeners) {
				try {
					listener(eventType, data);
				} catch {
					// listener error must not disrupt processing
				}
			}
			return;
		}

		// AC 4: agent_settled maps to run completion signal
		if (eventType === 'agent_settled') {
			this._isSettled = true;
			for (const resolver of this.settledResolvers) {
				resolver();
			}
			this.settledResolvers.clear();
		}

		// Notify raw event listeners
		for (const listener of this.eventListeners) {
			try {
				listener(data);
			} catch {
				// listener error must not disrupt processing
			}
		}

		// Map to standard envelopes
		const envelopes = mapPiEvents(data, {
			tracker: this.tracker,
			runId: this.runId,
			taskId: this.taskId,
		});

		for (const env of envelopes) {
			for (const listener of this.envelopeListeners) {
				try {
					listener(env);
				} catch {
					// listener error must not disrupt processing
				}
			}
		}
	}

	/**
	 * Send prompt command to the agent (AC 3).
	 */
	async prompt(
		message: string,
		images?: readonly PiImageContent[],
		streamingBehavior?: 'steer' | 'followUp',
	): Promise<PiRpcResponse> {
		this._isSettled = false;
		return this.sendCommand({
			type: 'prompt',
			message,
			images: images ? [...images] : undefined,
			streamingBehavior,
		});
	}

	/**
	 * Send steer command to interrupt and guide the agent mid-run (AC 3).
	 */
	async steer(message: string, images?: readonly PiImageContent[]): Promise<PiRpcResponse> {
		return this.sendCommand({
			type: 'steer',
			message,
			images: images ? [...images] : undefined,
		});
	}

	/**
	 * Send abort command to halt current operation (AC 3).
	 */
	async abort(): Promise<PiRpcResponse> {
		return this.sendCommand({
			type: 'abort',
		});
	}

	/**
	 * Send get_state command to read session state (AC 3).
	 */
	async getState(): Promise<PiRpcSessionState> {
		const response = await this.sendCommand({
			type: 'get_state',
		});
		if (response.success) {
			return (response.data as PiRpcSessionState) ?? {};
		}
		throw new AppError('E_INTERNAL', `Failed to get Pi state: ${response.error}`);
	}

	/**
	 * Waits for `agent_settled` event to arrive (AC 4).
	 */
	waitForSettled(timeoutMs?: number): Promise<void> {
		if (this._isSettled) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const timeout = timeoutMs ?? this.requestTimeoutMs;

			const timer = setTimeout(() => {
				this.settledResolvers.delete(onSettled);
				reject(new AppError('E_TIMEOUT', `Timeout waiting for agent_settled after ${timeout}ms`));
			}, timeout);

			const onSettled = () => {
				clearTimeout(timer);
				this.settledResolvers.delete(onSettled);
				resolve();
			};

			this.settledResolvers.add(onSettled);
		});
	}

	onEvent(listener: PiEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onEnvelope(listener: PiEnvelopeListener): () => void {
		this.envelopeListeners.add(listener);
		return () => {
			this.envelopeListeners.delete(listener);
		};
	}

	onUnmappedEvent(listener: (type: string, raw: unknown) => void): () => void {
		this.unmappedListeners.add(listener);
		return () => {
			this.unmappedListeners.delete(listener);
		};
	}

	dispose(): void {
		if (this._isDisposed) return;
		this._isDisposed = true;

		for (const cleanup of this.cleanupFns) {
			cleanup();
		}
		this.cleanupFns.length = 0;

		// Reject any pending requests
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new AppError('E_INTERNAL', 'Pi RPC client was disposed.'));
		}
		this.pendingRequests.clear();

		this.eventListeners.clear();
		this.envelopeListeners.clear();
		this.unmappedListeners.clear();
		this.settledResolvers.clear();
	}

	private sendCommand(command: PiRpcCommand): Promise<PiRpcResponse> {
		if (this._isDisposed) {
			return Promise.reject(new AppError('E_INTERNAL', 'Pi RPC client is disposed.'));
		}

		const id = `req_${++this.requestSequence}`;
		const payload = { ...command, id };
		const jsonLine = `${JSON.stringify(payload)}\n`;

		return new Promise<PiRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(
					new AppError(
						'E_TIMEOUT',
						`Pi RPC command '${command.type}' timed out after ${this.requestTimeoutMs}ms`,
					),
				);
			}, this.requestTimeoutMs);

			this.pendingRequests.set(id, {
				command: command.type,
				resolve,
				reject,
				timer,
			});

			try {
				if (this.transport) {
					this.transport.writeStdin(jsonLine);
				}
			} catch (err) {
				clearTimeout(timer);
				this.pendingRequests.delete(id);
				reject(new AppError('E_INTERNAL', `Failed to write command to stdin: ${String(err)}`));
			}
		});
	}

	private bindTransport(): void {
		if (!this.transport) return;

		// If transport provides onLine (like ManagedProcess), attach line listener
		if (typeof this.transport.onLine === 'function') {
			const unsub = this.transport.onLine((line: ReadLine) => {
				this.handleLine(line.text);
			});
			this.cleanupFns.push(unsub);
		} else if ('onChunk' in this.transport && typeof this.transport.onChunk === 'function') {
			const unsub = this.transport.onChunk((chunk: Buffer) => {
				this.pushChunk(chunk);
			});
			this.cleanupFns.push(unsub);
		}

		// Handle process exit
		if (typeof this.transport.onExit === 'function') {
			const unsub = this.transport.onExit((result) => {
				// If process exited without agent_settled, resolve or reject pending requests
				for (const pending of this.pendingRequests.values()) {
					clearTimeout(pending.timer);
					pending.reject(
						new AppError(
							'E_AGENT_UNAVAILABLE',
							`Pi process exited with code ${result.exitCode} before responding to '${pending.command}'`,
						),
					);
				}
				this.pendingRequests.clear();
			});
			this.cleanupFns.push(unsub);
		}
	}
}

export function createPiRpcClient(options: PiRpcClientOptions = {}): PiRpcClient {
	return new PiRpcClient(options);
}
