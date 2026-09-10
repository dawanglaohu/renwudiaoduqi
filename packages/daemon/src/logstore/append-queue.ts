import { AppError } from '../errors/app-error.ts';

export const DEFAULT_HIGH_WATERMARK_BYTES = 8 * 1024 * 1024; // 8 MiB (8,388,608 bytes)
export const DEFAULT_LOW_WATERMARK_BYTES = 4 * 1024 * 1024; // 4 MiB (4,194,304 bytes)

export interface PausableStream {
	pause(): void;
	resume(): void;
}

export interface AppendQueueOptions {
	readonly highWatermarkBytes?: number;
	readonly lowWatermarkBytes?: number;
	readonly stream?: PausableStream;
	readonly onPause?: () => void;
	readonly onResume?: () => void;
}

/**
 * Serialized async append point for log bytes with high/low watermark backpressure.
 *
 * Chains every append after the previous one so a resolved `append()` means
 * those bytes are at the end of the file. A failed append rejects that call;
 * the chain itself survives so later appends still run.
 *
 * Backpressure (AC 3):
 * When pending bytes exceed the high watermark (8 MiB default), attached streams
 * (e.g. child.stdout) are paused and onPause listeners are notified.
 * When writes complete and pending bytes fall back to or below the low watermark
 * (4 MiB default), attached streams are resumed and onResume listeners are notified.
 */
export interface AppendQueue {
	append(path: string, data: Uint8Array): Promise<void>;
	readonly pendingBytes: number;
	readonly isPaused?: boolean;
	readonly highWatermarkBytes?: number;
	readonly lowWatermarkBytes?: number;
	attachStream?(stream: PausableStream): () => void;
	onPause?(listener: () => void): () => void;
	onResume?(listener: () => void): () => void;
	drain(): Promise<void>;
}

export interface ManagedAppendQueue extends AppendQueue {
	readonly isPaused: boolean;
	readonly highWatermarkBytes: number;
	readonly lowWatermarkBytes: number;
	attachStream(stream: PausableStream): () => void;
	onPause(listener: () => void): () => void;
	onResume(listener: () => void): () => void;
}

export interface AppendQueueDeps {
	readonly appendFile: (path: string, data: Uint8Array) => Promise<void>;
}

export function createAppendQueue(
	deps: AppendQueueDeps,
	options: AppendQueueOptions = {},
): ManagedAppendQueue {
	const highWatermarkBytes = options.highWatermarkBytes ?? DEFAULT_HIGH_WATERMARK_BYTES;
	const lowWatermarkBytes = options.lowWatermarkBytes ?? DEFAULT_LOW_WATERMARK_BYTES;

	if (lowWatermarkBytes > highWatermarkBytes) {
		throw new AppError(
			'E_VALIDATION',
			`AppendQueue lowWatermarkBytes (${lowWatermarkBytes}) cannot exceed highWatermarkBytes (${highWatermarkBytes})`,
			{ details: { lowWatermarkBytes, highWatermarkBytes } },
		);
	}

	const attachedStreams = new Set<PausableStream>();
	if (options.stream !== undefined) {
		attachedStreams.add(options.stream);
	}

	const pauseListeners = new Set<() => void>();
	if (options.onPause !== undefined) {
		pauseListeners.add(options.onPause);
	}

	const resumeListeners = new Set<() => void>();
	if (options.onResume !== undefined) {
		resumeListeners.add(options.onResume);
	}

	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;
	let isPaused = false;

	function triggerPause(): void {
		if (isPaused) return;
		isPaused = true;
		for (const stream of attachedStreams) {
			try {
				stream.pause();
			} catch {
				// Do not let stream failure disrupt append queue
			}
		}
		for (const listener of pauseListeners) {
			try {
				listener();
			} catch {
				// Do not let listener error disrupt append queue
			}
		}
	}

	function triggerResume(): void {
		if (!isPaused) return;
		isPaused = false;
		for (const stream of attachedStreams) {
			try {
				stream.resume();
			} catch {
				// Do not let stream failure disrupt append queue
			}
		}
		for (const listener of resumeListeners) {
			try {
				listener();
			} catch {
				// Do not let listener error disrupt append queue
			}
		}
	}

	async function runAppend(path: string, data: Uint8Array): Promise<void> {
		try {
			await deps.appendFile(path, data);
		} finally {
			pending -= data.byteLength;
			if (isPaused && pending <= lowWatermarkBytes) {
				triggerResume();
			}
		}
	}

	return {
		append(path: string, data: Uint8Array): Promise<void> {
			pending += data.byteLength;
			if (!isPaused && pending > highWatermarkBytes) {
				triggerPause();
			}
			const write = tail.then(() => runAppend(path, data));
			tail = write.catch(() => undefined);
			return write;
		},
		get pendingBytes(): number {
			return pending;
		},
		get isPaused(): boolean {
			return isPaused;
		},
		get highWatermarkBytes(): number {
			return highWatermarkBytes;
		},
		get lowWatermarkBytes(): number {
			return lowWatermarkBytes;
		},
		attachStream(stream: PausableStream): () => void {
			attachedStreams.add(stream);
			if (isPaused) {
				try {
					stream.pause();
				} catch {
					// Ignore
				}
			}
			return () => {
				attachedStreams.delete(stream);
			};
		},
		onPause(listener: () => void): () => void {
			pauseListeners.add(listener);
			return () => {
				pauseListeners.delete(listener);
			};
		},
		onResume(listener: () => void): () => void {
			resumeListeners.add(listener);
			return () => {
				resumeListeners.delete(listener);
			};
		},
		async drain(): Promise<void> {
			await tail;
			if (isPaused && pending <= lowWatermarkBytes) {
				triggerResume();
			}
		},
	};
}
