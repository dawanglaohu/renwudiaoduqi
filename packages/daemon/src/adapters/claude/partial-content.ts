interface PartialBlock {
	readonly type: unknown;
	emitted: string;
}

interface PartialMessage {
	readonly id: unknown;
	readonly blocks: Map<number, PartialBlock>;
	currentIndex?: number;
}

/** Content ownership for one CLI process; main and subagent streams have separate parents. */
export class ClaudePartialContent {
	private readonly messages = new Map<string | null, PartialMessage>();

	observe(frame: Record<string, unknown>): void {
		const parent = this.parent(frame);
		if (frame.type === 'result') {
			this.messages.delete(parent);
			return;
		}
		if (frame.type !== 'stream_event' || !frame.event || typeof frame.event !== 'object') return;
		const event = frame.event as Record<string, unknown>;
		if (event.type === 'message_start') {
			const message = event.message as Record<string, unknown> | undefined;
			this.messages.set(parent, { id: message?.id, blocks: new Map() });
			return;
		}
		if (event.type === 'message_stop') {
			this.messages.delete(parent);
			return;
		}
		const message = this.messages.get(parent);
		if (!message || typeof event.index !== 'number') return;
		if (event.type === 'content_block_start') {
			const block = event.content_block as Record<string, unknown> | undefined;
			message.currentIndex = event.index;
			message.blocks.set(event.index, { type: block?.type, emitted: '' });
		} else if (event.type === 'content_block_delta') {
			const block = message.blocks.get(event.index);
			const delta = event.delta as Record<string, unknown> | undefined;
			if (
				block?.type === 'text' &&
				delta?.type === 'text_delta' &&
				typeof delta.text === 'string'
			) {
				block.emitted += delta.text;
			} else if (
				block?.type === 'thinking' &&
				delta?.type === 'thinking_delta' &&
				typeof delta.thinking === 'string'
			) {
				block.emitted += delta.thinking;
			}
		}
		// Keep block evidence through block_stop: the complete frame can arrive on either side.
	}

	remaining(
		frame: Record<string, unknown>,
		message: Record<string, unknown>,
		index: number,
		type: 'text' | 'thinking',
		complete: string,
	): string {
		const partial = this.messages.get(this.parent(frame));
		if (!partial || typeof message.id !== 'string' || partial.id !== message.id) return complete;
		// Claude Code emits one complete block per assistant frame, even when message.id is shared.
		const blockIndex =
			Array.isArray(message.content) && message.content.length === 1
				? (partial.currentIndex ?? index)
				: index;
		const block = partial.blocks.get(blockIndex);
		if (block?.type !== type || !complete.startsWith(block.emitted)) return complete;
		const remaining = complete.slice(block.emitted.length);
		block.emitted = complete;
		return remaining;
	}

	reset(): void {
		this.messages.clear();
	}

	private parent(frame: Record<string, unknown>): string | null {
		return typeof frame.parent_tool_use_id === 'string' ? frame.parent_tool_use_id : null;
	}
}
