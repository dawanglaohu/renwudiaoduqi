// 禁止 child.stdout.setEncoding()（多字节 UTF-8 会被 chunk 边界切碎）
// 禁止 readline（E-203：U+2028 / U+2029 在 JSON 字符串里合法但会被断行）

export const MAX_LINE_BYTE_LENGTH = 1024 * 1024; // 1 MiB = 1,048,576 bytes

export interface ReadLine {
	readonly text: string;
	readonly truncated: boolean;
	readonly rawByteLen: number;
}

export interface ParsedJsonLine<T = unknown> extends ReadLine {
	readonly isJson: boolean;
	readonly value?: T;
	readonly jsonError?: Error;
}

export interface LineReaderOptions {
	readonly maxLineByteLength?: number;
}

export interface LineReader {
	push(chunk: Buffer): readonly ReadLine[];
	flush(): readonly ReadLine[];
	reset(): void;
	readonly bufferedBytes: number;
	readonly isDiscardingExcess: boolean;
}

export function createLineReader(options: LineReaderOptions = {}): LineReader {
	const maxBytes = options.maxLineByteLength ?? MAX_LINE_BYTE_LENGTH;
	let bufferedChunks: Buffer[] = [];
	let bufferedLength = 0;
	let isDiscarding = false;
	let excessRawByteLen = 0;
	let truncatedPrefix: Buffer | null = null;

	function finalizeLine(contentBuffer: Buffer, truncated: boolean, rawByteLen: number): ReadLine {
		let lineBuf = contentBuffer;
		if (!truncated && lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
			lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
		}
		const text = lineBuf.toString('utf8');
		return Object.freeze({
			text,
			truncated,
			rawByteLen,
		});
	}

	function push(chunk: Buffer): readonly ReadLine[] {
		const lines: ReadLine[] = [];
		let currentOffset = 0;

		while (currentOffset < chunk.length) {
			if (isDiscarding) {
				const newlineIndex = chunk.indexOf(0x0a, currentOffset);
				if (newlineIndex === -1) {
					excessRawByteLen += chunk.length - currentOffset;
					currentOffset = chunk.length;
					break;
				}

				const discardedFromChunk = newlineIndex - currentOffset;
				excessRawByteLen += discardedFromChunk;
				const fullRawLen = excessRawByteLen;
				const prefix = truncatedPrefix ?? Buffer.alloc(0);

				lines.push(finalizeLine(prefix, true, fullRawLen));

				// Reset discarding state
				isDiscarding = false;
				excessRawByteLen = 0;
				truncatedPrefix = null;
				currentOffset = newlineIndex + 1;
				continue;
			}

			const newlineIndex = chunk.indexOf(0x0a, currentOffset);
			if (newlineIndex !== -1) {
				const sliceFromChunk = chunk.subarray(currentOffset, newlineIndex);
				const lineRawLen = bufferedLength + sliceFromChunk.length;

				let lineBuffer: Buffer;
				if (bufferedChunks.length === 0) {
					lineBuffer = sliceFromChunk;
				} else {
					bufferedChunks.push(sliceFromChunk);
					lineBuffer = Buffer.concat(bufferedChunks, lineRawLen);
					bufferedChunks = [];
					bufferedLength = 0;
				}

				if (lineRawLen > maxBytes) {
					lines.push(finalizeLine(lineBuffer.subarray(0, maxBytes), true, lineRawLen));
				} else {
					lines.push(finalizeLine(lineBuffer, false, lineRawLen));
				}

				currentOffset = newlineIndex + 1;
				continue;
			}

			// No newline found in the remainder of chunk
			const remainingFromChunk = chunk.subarray(currentOffset);
			const totalIfBuffered = bufferedLength + remainingFromChunk.length;

			if (totalIfBuffered > maxBytes) {
				// Exceeds 1 MiB limit: capture up to maxBytes, switch to discarding excess
				const neededFromChunk = Math.max(0, maxBytes - bufferedLength);
				const chunkPrefix = remainingFromChunk.subarray(0, neededFromChunk);
				bufferedChunks.push(chunkPrefix);
				truncatedPrefix = Buffer.concat(bufferedChunks, maxBytes);
				bufferedChunks = [];
				bufferedLength = 0;

				isDiscarding = true;
				excessRawByteLen = totalIfBuffered;
				currentOffset = chunk.length;
				break;
			}

			bufferedChunks.push(remainingFromChunk);
			bufferedLength = totalIfBuffered;
			currentOffset = chunk.length;
			break;
		}

		return Object.freeze(lines);
	}

	function flush(): readonly ReadLine[] {
		const lines: ReadLine[] = [];
		if (isDiscarding) {
			const prefix = truncatedPrefix ?? Buffer.alloc(0);
			lines.push(finalizeLine(prefix, true, excessRawByteLen));
			isDiscarding = false;
			excessRawByteLen = 0;
			truncatedPrefix = null;
		} else if (bufferedLength > 0) {
			const lineBuffer =
				bufferedChunks.length === 1 && bufferedChunks[0] !== undefined
					? bufferedChunks[0]
					: Buffer.concat(bufferedChunks, bufferedLength);
			lines.push(finalizeLine(lineBuffer, false, bufferedLength));
			bufferedChunks = [];
			bufferedLength = 0;
		}
		return Object.freeze(lines);
	}

	function reset(): void {
		bufferedChunks = [];
		bufferedLength = 0;
		isDiscarding = false;
		excessRawByteLen = 0;
		truncatedPrefix = null;
	}

	return {
		push,
		flush,
		reset,
		get bufferedBytes() {
			return bufferedLength;
		},
		get isDiscardingExcess() {
			return isDiscarding;
		},
	};
}

export function parseJsonLine<T = unknown>(line: ReadLine): ParsedJsonLine<T> {
	if (line.truncated) {
		return Object.freeze({
			...line,
			isJson: false,
			jsonError: new Error('Line was truncated'),
		});
	}
	const trimmed = line.text.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return Object.freeze({ ...line, isJson: false });
	}
	try {
		const value = JSON.parse(line.text) as T;
		return Object.freeze({ ...line, isJson: true, value });
	} catch (cause) {
		return Object.freeze({ ...line, isJson: false, jsonError: cause as Error });
	}
}

export function parseLinesFromBuffer(
	buffer: Buffer,
	options: LineReaderOptions = {},
): readonly ReadLine[] {
	const reader = createLineReader(options);
	const lines = [...reader.push(buffer), ...reader.flush()];
	return Object.freeze(lines);
}
