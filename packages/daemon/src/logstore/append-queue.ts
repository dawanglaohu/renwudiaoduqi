/**
 * Serialized async append point for log bytes.
 *
 * Chains every append after the previous one so segment bookkeeping on the
 * caller side can treat a resolved `append()` as "bytes durably at the end".
 * A failed append rejects that call; the chain itself survives so later
 * appends still run.
 */
export interface AppendQueue {
	/** Queue `data` for append to `path`. Resolves once the bytes hit disk. */
	append(path: string, data: Uint8Array): Promise<void>;
	/** Bytes queued but not yet written. Drives the 8/4 MiB pause/resume backpressure. */
	readonly pendingBytes: number;
	/** Wait until every queued append has finished. */
	drain(): Promise<void>;
}

export interface AppendQueueDeps {
	readonly appendFile: (path: string, data: Uint8Array) => Promise<void>;
}

export function createAppendQueue(deps: AppendQueueDeps): AppendQueue {
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;

	async function runAppend(path: string, data: Uint8Array): Promise<void> {
		try {
			await deps.appendFile(path, data);
		} finally {
			pending -= data.byteLength;
		}
	}

	return {
		append(path: string, data: Uint8Array): Promise<void> {
			const write = tail.then(() => runAppend(path, data));
			// The chain itself must never reject, or every later append would be skipped.
			tail = write.catch(() => undefined);
			pending += data.byteLength;
			return write;
		},
		get pendingBytes(): number {
			return pending;
		},
		async drain(): Promise<void> {
			await tail;
		},
	};
}
