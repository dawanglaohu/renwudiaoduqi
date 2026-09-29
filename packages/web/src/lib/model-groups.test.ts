/**
 * packages/web/src/lib/model-groups.test.ts
 *
 * 模型按来源切组与子组切分单测（AC 2, E-338, E-339, E-350 / 决策 134）
 */

import type { AgentModelItem } from '@agent-scheduler/shared/api/agents';
import { describe, expect, it } from 'vitest';
import { groupModelsBySource } from './model-groups.ts';

describe('model-groups: source grouping and provider sub-grouping', () => {
	it('groups models in MODEL_SOURCES order, skips empty groups, and always renders manual group', () => {
		const models: AgentModelItem[] = [
			{ name: 'gpt-4o', source: 'history', isCurrentConfig: false },
			{ name: 'claude-3-5-sonnet', source: 'live', isCurrentConfig: true },
		];

		const result = groupModelsBySource(models);
		// Order must be live -> history -> manual (config and builtin skipped as empty)
		expect(result.groups.map((g) => g.source)).toEqual(['live', 'history', 'manual']);
		expect(result.defaultSelectedModel).toBe('claude-3-5-sonnet');
		expect(result.unknownSources).toEqual([]);

		// Manual group contains exactly one action item
		const manualGroup = result.groups.find((g) => g.source === 'manual');
		expect(manualGroup).toBeDefined();
		expect(manualGroup?.subgroups[0]?.items).toHaveLength(1);
		expect(manualGroup?.subgroups[0]?.items[0]?.name).toBe('手填模型名…');
		expect(manualGroup?.subgroups[0]?.items[0]?.isManualAction).toBe(true);
	});

	it('splits items with provider into subgroups in order of first appearance', () => {
		const models: AgentModelItem[] = [
			{ name: 'anthropic/claude-3-opus', source: 'live', provider: 'anthropic', isCurrentConfig: false },
			{ name: 'openai/gpt-4o', source: 'live', provider: 'openai', isCurrentConfig: false },
			{ name: 'anthropic/claude-3.5-sonnet', source: 'live', provider: 'anthropic', isCurrentConfig: false },
			{ name: 'custom-local', source: 'live', isCurrentConfig: false },
		];

		const result = groupModelsBySource(models);
		const liveGroup = result.groups.find((g) => g.source === 'live');
		expect(liveGroup).toBeDefined();

		// Subgroups should appear in order: anthropic -> openai -> undefined
		expect(liveGroup?.subgroups.map((sg) => sg.provider)).toEqual(['anthropic', 'openai', undefined]);

		const anthropicGroup = liveGroup?.subgroups.find((sg) => sg.provider === 'anthropic');
		expect(anthropicGroup?.items.map((i) => i.name)).toEqual([
			'anthropic/claude-3-opus',
			'anthropic/claude-3.5-sonnet',
		]);
	});

	it('preserves duplicate names without deduplicating or reordering (AC 2, E-350)', () => {
		const models: AgentModelItem[] = [
			{ name: 'duplicate-model', source: 'live', isCurrentConfig: false },
			{ name: 'duplicate-model', source: 'live', isCurrentConfig: false },
			{ name: 'duplicate-model', source: 'config', isCurrentConfig: true },
		];

		const result = groupModelsBySource(models);
		const liveGroup = result.groups.find((g) => g.source === 'live');
		expect(liveGroup?.subgroups[0]?.items).toHaveLength(2);
		expect(liveGroup?.subgroups[0]?.items[0]?.name).toBe('duplicate-model');
		expect(liveGroup?.subgroups[0]?.items[1]?.name).toBe('duplicate-model');

		const configGroup = result.groups.find((g) => g.source === 'config');
		expect(configGroup?.subgroups[0]?.items).toHaveLength(1);
		expect(configGroup?.subgroups[0]?.items[0]?.name).toBe('duplicate-model');
	});

	it('collects unknown sources at the end and returns unknownSources array (决策 134)', () => {
		const models: AgentModelItem[] = [
			{ name: 'model-a', source: 'live', isCurrentConfig: false },
			{ name: 'model-b', source: 'custom_source' as any, isCurrentConfig: false },
			{ name: 'model-c', source: 'another_source' as any, isCurrentConfig: false },
		];

		const result = groupModelsBySource(models);
		expect(result.unknownSources).toEqual(['custom_source', 'another_source']);

		const otherGroup = result.groups.find((g) => g.source === 'other');
		expect(otherGroup).toBeDefined();
		expect(otherGroup?.subgroups[0]?.items.map((i) => i.name)).toEqual(['model-b', 'model-c']);
	});
});
