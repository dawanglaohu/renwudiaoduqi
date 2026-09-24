import { describe, expect, it } from 'vitest';
import {
	LOOP_PIECES,
	STATUS_STATES,
	STEP_TYPES,
	getStatusShape,
	getStepShape,
	normalizeStatusState,
	renderSpineShapeSvg,
} from './spine-shape.ts';

describe('lib/spine-shape (M9-T21 & M9-T7 / LOOP_PIECES & shapes)', () => {
	it('AC 3: LOOP_PIECES defines top, middle, bottom and start, intermediate, end loop pieces', () => {
		expect(LOOP_PIECES).toBeDefined();

		// Top / start of loop: vertical line down + hook into spine
		expect(LOOP_PIECES.top).toEqual({ below: true, hook: true });
		expect(LOOP_PIECES.start).toEqual({ below: true, hook: true });

		// Middle / intermediate of loop: vertical line through
		expect(LOOP_PIECES.middle).toEqual({ above: true, below: true });
		expect(LOOP_PIECES.intermediate).toEqual({ above: true, below: true });

		// Bottom / end of loop: vertical line from above + hook into spine
		expect(LOOP_PIECES.bottom).toEqual({ above: true, hook: true });
		expect(LOOP_PIECES.end).toEqual({ above: true, hook: true });
	});

	it('STATUS_STATES has exactly 12 states and 6 step types', () => {
		expect(STATUS_STATES).toHaveLength(12);
		expect(STEP_TYPES).toHaveLength(6);

		for (const state of STATUS_STATES) {
			const shape = getStatusShape(state);
			expect(shape).toBeDefined();
			expect(shape.id).toBe(state);
		}

		for (const type of STEP_TYPES) {
			const shape = getStepShape(type);
			expect(shape).toBeDefined();
			expect(shape.elements.length).toBeGreaterThan(0);
		}
	});

	it('normalizeStatusState handles null, undefined, unknown, and run states', () => {
		expect(normalizeStatusState(null)).toBe('unrecognized');
		expect(normalizeStatusState(undefined)).toBe('unrecognized');
		expect(normalizeStatusState('unknown_foo')).toBe('unrecognized');
		expect(normalizeStatusState('running')).toBe('thinking');
		expect(normalizeStatusState('landed')).toBe('succeeded');
		expect(normalizeStatusState('failed')).toBe('failed');
	});

	it('renderSpineShapeSvg renders valid svg markup', () => {
		const shape = getStatusShape('succeeded');
		const svg = renderSpineShapeSvg(shape, { size: 16 });
		expect(svg).toContain('<svg');
		expect(svg).toContain('viewBox="0 0 16 16"');
		expect(svg).toContain('width="16"');
		expect(svg).toContain('height="16"');
	});
});
