/**
 * Serialized async append point for log bytes.
 *
 * Chains every append after the previous one so a resolved `append()` means
 * those bytes are at the end of the file. A failed append rejects that call;
 * the chain itself survives so later appends still run.
 */
export interface AppendQueue {
	append(path: string, data: Uint8Array): Promise<void>;
	readonly pendingBytes: number;
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
