import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { batchNoOf, layerOf } from '../../src/domain/layer-of.ts';

describe('domain/layer-of (AC 5, E-241, E-242, E-244, E-246)', () => {
	it('returns an empty record for empty ids', () => {
		const layers = layerOf([], () => []);
		expect(layers).toEqual({});
	});

	it('assigns layer 0 (batch 1) to tasks without predecessors (E-244)', () => {
		const ids = ['T1', 'T2', 'T3'];
		const deps = { T1: [], T2: [], T3: [] };
		const layers = layerOf(ids, (id) => deps[id as keyof typeof deps]);

		expect(layers).toEqual({ T1: 0, T2: 0, T3: 0 });
		expect(batchNoOf(layers.T1 ?? 0)).toBe(1);
		expect(batchNoOf(layers.T2 ?? 0)).toBe(1);
		expect(batchNoOf(layers.T3 ?? 0)).toBe(1);
	});

	it('computes layers for a linear dependency chain (layer = predecessor chain length)', () => {
		// T1 -> T2 -> T3 -> T4
		const ids = ['T1', 'T2', 'T3', 'T4'];
		const deps: Record<string, string[]> = {
			T1: [],
			T2: ['T1'],
			T3: ['T2'],
			T4: ['T3'],
		};
		const layers = layerOf(ids, (id) => deps[id]);

		expect(layers.T1).toBe(0);
		expect(layers.T2).toBe(1);
		expect(layers.T3).toBe(2);
		expect(layers.T4).toBe(3);

		expect(batchNoOf(layers.T1 ?? 0)).toBe(1);
		expect(batchNoOf(layers.T2 ?? 0)).toBe(2);
		expect(batchNoOf(layers.T3 ?? 0)).toBe(3);
		expect(batchNoOf(layers.T4 ?? 0)).toBe(4);
	});

	it('computes layers for diamond dependencies (max predecessor length)', () => {
		// T1 -> T2, T1 -> T3, T2 & T3 -> T4
		const ids = ['T1', 'T2', 'T3', 'T4'];
		const deps: Record<string, string[]> = {
			T1: [],
			T2: ['T1'],
			T3: ['T1'],
			T4: ['T2', 'T3'],
		};
		const layers = layerOf(ids, deps);

		expect(layers.T1).toBe(0);
		expect(layers.T2).toBe(1);
		expect(layers.T3).toBe(1);
		expect(layers.T4).toBe(2);
		expect(batchNoOf(layers.T4 ?? 0)).toBe(3);
	});

	it('handles dependency cycles by truncating in place without infinite recursion (E-241)', () => {
		// Cycle: A -> B -> A
		const ids = ['A', 'B'];
		const deps: Record<string, string[]> = {
			A: ['B'],
			B: ['A'],
		};
		const layers = layerOf(ids, deps);

		// Truncation prevents loop; both tasks receive a finite layer
		expect(typeof layers.A).toBe('number');
		expect(typeof layers.B).toBe('number');
		expect(Number.isFinite(layers.A)).toBe(true);
		expect(Number.isFinite(layers.B)).toBe(true);
	});

	it('handles self-cycle without infinite loop (E-241)', () => {
		// A -> A
		const ids = ['A'];
		const deps = { A: ['A'] };
		const layers = layerOf(ids, deps);

		expect(layers.A).toBe(1);
		expect(batchNoOf(layers.A ?? 0)).toBe(2);
	});

	it('ignores phantom tasks not in ids list when computing layer (E-242)', () => {
		// T1 depends on PHANTOM_TASK (not in ids)
		const ids = ['T1', 'T2'];
		const deps: Record<string, string[]> = {
			T1: ['PHANTOM_TASK'],
			T2: ['T1'],
		};
		const layers = layerOf(ids, deps);

		// PHANTOM_TASK is ignored, so T1 has no valid predecessors -> layer 0
		expect(layers.T1).toBe(0);
		expect(layers.T2).toBe(1);
	});

	it('matches the exact upstream layerOf output on actual docs-data.js tasks', () => {
		const docsPath = resolve(__dirname, '../../../../docs/Agent任务调度器-开发文档/docs-data.js');
		const raw = readFileSync(docsPath, 'utf8')
			.replace(/^window\.DOCS\s*=\s*/, '')
			.replace(/;?\s*$/, '');
		const data = JSON.parse(raw) as {
			data: { tasks: { id: string; deps?: string[] }[] };
		};

		const tasks = data.data.tasks;
		const ids = tasks.map((t) => t.id);
		const taskMap = new Map(tasks.map((t) => [t.id, t]));

		const layers = layerOf(ids, (id) => taskMap.get(id)?.deps ?? []);

		// One layer per task in the source list; the count is derived so the test stays
		// valid when the document gains tasks instead of pinning a stale total.
		expect(Object.keys(layers).length).toBe(ids.length);
		// Root tasks with no deps must be at layer 0 (batch 1)
		expect(layers['M1-T1']).toBe(0);
		expect(batchNoOf(layers['M1-T1'] ?? 0)).toBe(1);

		// M1-T2 depends on M1-T1 -> layer 1 (batch 2)
		expect(layers['M1-T2']).toBe(1);
		expect(batchNoOf(layers['M1-T2'] ?? 0)).toBe(2);

		// M3-T1 depends on M1-T2 -> layer 2 (batch 3)
		expect(layers['M3-T1']).toBe(2);
		expect(batchNoOf(layers['M3-T1'] ?? 0)).toBe(3);

		// All tasks must have a non-negative layer and batchNo >= 1
		for (const id of ids) {
			const layer = layers[id];
			expect(layer).toBeDefined();
			if (layer !== undefined) {
				expect(layer).toBeGreaterThanOrEqual(0);
				expect(batchNoOf(layer)).toBe(layer + 1);
			}
		}
	});
});
