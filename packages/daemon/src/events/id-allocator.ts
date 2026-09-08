export const WATERMARK_BATCH_SIZE = 1000;
export const GLOBAL_EVENT_SEQUENCE_NAME = 'events';

export interface EventSeqStore {
	readonly getWatermark: (name: string) => number | null;
	readonly setWatermark: (name: string, watermark: number) => void;
}

export interface IdAllocator {
	readonly allocate: () => number;
	readonly currentWatermark: () => number;
	readonly nextId: () => number;
}

export interface IdAllocatorDeps {
	readonly store: EventSeqStore;
}

export function createIdAllocator(deps: IdAllocatorDeps): IdAllocator {
	const { store } = deps;
	const existingWatermark = store.getWatermark(GLOBAL_EVENT_SEQUENCE_NAME);

	let nextAllocatableId: number;
	let watermarkLimit: number;

	if (existingWatermark === null) {
		watermarkLimit = WATERMARK_BATCH_SIZE;
		store.setWatermark(GLOBAL_EVENT_SEQUENCE_NAME, watermarkLimit);
		nextAllocatableId = 1;
	} else {
		// Reserving the next batch before allocation prevents a restart from reusing issued IDs.
		watermarkLimit = existingWatermark + WATERMARK_BATCH_SIZE;
		store.setWatermark(GLOBAL_EVENT_SEQUENCE_NAME, watermarkLimit);
		nextAllocatableId = existingWatermark + 1;
	}

	function allocate(): number {
		if (nextAllocatableId > watermarkLimit) {
			const newWatermark = watermarkLimit + WATERMARK_BATCH_SIZE;
			store.setWatermark(GLOBAL_EVENT_SEQUENCE_NAME, newWatermark);
			watermarkLimit = newWatermark;
		}

		const id = nextAllocatableId;
		nextAllocatableId += 1;
		return id;
	}

	return Object.freeze({
		allocate,
		currentWatermark: () => watermarkLimit,
		nextId: () => nextAllocatableId,
	});
}
