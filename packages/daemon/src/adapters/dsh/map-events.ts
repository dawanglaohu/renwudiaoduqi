import type { EventKind, EventPayloadMap } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
	readonly scope?: string;
}

export interface DshMapEventsContext {
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface DshMapEventsResult {
	readonly events: readonly EventEnvelopeInput[];
	readonly unmappedCount: number;
	readonly parseError?: boolean;
	readonly rawLine: string;
}

/**
 * All dsh vendor-specific event method and type strings.
 * Architecture test asserts these strings ONLY appear in adapters/dsh/
 * and NEVER leak into service/, jobs/, or http/ layers.
 */
export const DSH_VENDOR_EVENT_STRINGS = Object.freeze([
	'turn/end',
	'turn.end',
	'turn/started',
	'turn.started',
	'turn/completed',
	'turn.completed',
	'turn/failed',
	'turn.failed',
	'headless/completed',
	'headless.completed',
	'headless/done',
	'session/end',
	'session.end',
] as const);

export function isKnownDshEventType(type: string): boolean {
	return (DSH_VENDOR_EVENT_STRINGS as readonly string[]).includes(type);
}

/**
 * Tests whether a line of text is a dsh startup banner or progress indicator,
 * which should not produce agent_message_chunk events (R2 b).
 */
function isBannerOrProgressLine(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	return /^(?:\[(?:info|progress|debug|trace|warn)\]|={2,}|-{2,}|DeepSeek Harness|Loading profile|Initializing|Running\.\.\.)/i.test(
		trimmed,
	);
}

/**
 * Pure function mapping a single output line or object from dsh (--profile headless)
 * into normalized ACP event envelope inputs.
 *
 * AC 2 & E-253 & R2:
 * (a) Correctly processes object inputs without String(obj) -> [object Object]
 * (b) Only terminal assistant text becomes agent_message_chunk; banners/progress lines emit nothing
 * (c) Provides plain-text stdout passage
 * (d) Unrecognized JSON lines without text/discriminants are dropped and counted in unmappedCount
 * (e) Carries vendor payload, preserves multi-line newlines
 */
export function mapDshEvents(
	vendorLine: unknown,
	context?: DshMapEventsContext,
): readonly EventEnvelopeInput[] {
	return parseAndMapDshLine(vendorLine, context).events;
}

/**
 * Parses and maps a line from dsh, tracking unmapped counts and parse errors.
 */
export function parseAndMapDshLine(
	vendorLine: unknown,
	context?: DshMapEventsContext,
): DshMapEventsResult {
	const rawLine = typeof vendorLine === 'string' ? vendorLine : JSON.stringify(vendorLine);

	if (vendorLine === null || vendorLine === undefined) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine: '',
		});
	}

	const runId = context?.runId ?? null;
	const taskId = context?.taskId ?? null;
	const actorDeviceId = context?.actorDeviceId ?? null;

	// (a) Handle object input directly without String(obj) -> "[object Object]"
	if (typeof vendorLine === 'object' && !Array.isArray(vendorLine)) {
		const obj = vendorLine as Record<string, unknown>;
		const methodOrType = (obj.method ?? obj.type ?? obj.event) as string | undefined;

		if (methodOrType && isKnownDshEventType(methodOrType)) {
			switch (methodOrType) {
				case 'turn/end':
				case 'turn.end':
				case 'turn/completed':
				case 'turn.completed':
				case 'headless/completed':
				case 'headless.completed':
				case 'headless/done':
				case 'session/end':
				case 'session.end': {
					const text =
						typeof obj.text === 'string'
							? obj.text
							: typeof obj.content === 'string'
								? obj.content
								: typeof obj.message === 'string'
									? obj.message
									: '';
					if (text.length > 0 && !isBannerOrProgressLine(text)) {
						return Object.freeze({
							events: Object.freeze([
								{
									kind: 'agent_message_chunk' as const,
									payload: {
										chunk: text,
										content: text,
										delta: text,
										vendor: vendorLine,
									},
									runId,
									taskId,
									actorDeviceId,
									scope: 'run',
								},
							]),
							unmappedCount: 0,
							rawLine,
						});
					}
					return Object.freeze({
						events: Object.freeze([]),
						unmappedCount: 0,
						rawLine,
					});
				}
				default:
					return Object.freeze({
						events: Object.freeze([]),
						unmappedCount: 0,
						rawLine,
					});
			}
		}

		// Check if object contains direct text/content fields
		const text =
			typeof obj.text === 'string'
				? obj.text
				: typeof obj.content === 'string'
					? obj.content
					: typeof obj.message === 'string'
						? obj.message
						: undefined;

		if (text !== undefined && text.length > 0 && !isBannerOrProgressLine(text)) {
			return Object.freeze({
				events: Object.freeze([
					{
						kind: 'agent_message_chunk' as const,
						payload: {
							chunk: text,
							content: text,
							delta: text,
							vendor: vendorLine,
						},
						runId,
						taskId,
						actorDeviceId,
						scope: 'run',
					},
				]),
				unmappedCount: 0,
				rawLine,
			});
		}

		// (d) Object without recognized discriminant or text -> drop as unknown event and increment count
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 1,
			rawLine,
		});
	}

	// Handle string input
	if (typeof vendorLine === 'string') {
		const trimmed = vendorLine.trim();
		if (trimmed.length === 0) {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				rawLine,
			});
		}

		// If it's a JSON string
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed = JSON.parse(trimmed) as Record<string, unknown>;
				return parseAndMapDshLine(parsed, context);
			} catch {
				return Object.freeze({
					events: Object.freeze([]),
					unmappedCount: 0,
					parseError: true,
					rawLine,
				});
			}
		}

		// (b) Plain text stdout: filter out banners and progress lines
		if (isBannerOrProgressLine(vendorLine)) {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				rawLine,
			});
		}

		// (e) Terminal assistant text output: preserve original text and newlines, include vendor
		return Object.freeze({
			events: Object.freeze([
				{
					kind: 'agent_message_chunk' as const,
					payload: {
						chunk: vendorLine,
						content: vendorLine,
						delta: vendorLine,
						vendor: vendorLine,
					},
					runId,
					taskId,
					actorDeviceId,
					scope: 'run',
				},
			]),
			unmappedCount: 0,
			rawLine,
		});
	}

	return Object.freeze({
		events: Object.freeze([]),
		unmappedCount: 0,
		rawLine,
	});
}

export { mapDshEvents as mapEvents };
