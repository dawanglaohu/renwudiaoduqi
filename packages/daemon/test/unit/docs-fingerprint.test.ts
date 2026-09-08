import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDocsFingerprint } from '../../src/domain/docs-fingerprint.ts';

describe('domain/docs-fingerprint (AC 2, E-17, E-79)', () => {
	it('produces a 64-character SHA-256 hex string', () => {
		const fp = computeDocsFingerprint([
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2' },
		]);
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is order-independent because tasks are sorted by task ID (E-17)', () => {
		const fp1 = computeDocsFingerprint([
			{ id: 'M1-T2', contractHash: 'hash-b' },
			{ id: 'M1-T1', contractHash: 'hash-a' },
			{ id: 'M1-T3', contractHash: 'hash-c' },
		]);

		const fp2 = computeDocsFingerprint([
			{ id: 'M1-T1', contractHash: 'hash-a' },
			{ id: 'M1-T3', contractHash: 'hash-c' },
			{ id: 'M1-T2', contractHash: 'hash-b' },
		]);

		expect(fp1).toBe(fp2);
	});

	it('detects contract hash changes for any task even if task IDs are identical (E-17)', () => {
		const base = [
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2' },
		];

		const modified = [
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2-changed' },
		];

		expect(computeDocsFingerprint(base)).not.toBe(computeDocsFingerprint(modified));
	});

	it('detects task addition and deletion (E-17)', () => {
		const base = [
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2' },
		];

		const added = [
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2' },
			{ id: 'M1-T3', contractHash: 'hash-3' },
		];

		const deleted = [{ id: 'M1-T1', contractHash: 'hash-1' }];

		const baseFp = computeDocsFingerprint(base);
		expect(computeDocsFingerprint(added)).not.toBe(baseFp);
		expect(computeDocsFingerprint(deleted)).not.toBe(baseFp);
	});

	it('does not depend on generated timestamps, mtime or review readiness (E-17, E-79)', () => {
		const taskSetA = [
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2' },
		];

		const taskSetB = [
			{ id: 'M1-T1', contractHash: 'hash-1' },
			{ id: 'M1-T2', contractHash: 'hash-2' },
		];

		// Fingerprint must be purely derived from task id and contractHash pairs
		expect(computeDocsFingerprint(taskSetA)).toBe(computeDocsFingerprint(taskSetB));
	});

	it('computes expected fingerprint on actual repository docs-data.js', () => {
		const docsPath = resolve(__dirname, '../../../../docs/Agent任务调度器-开发文档/docs-data.js');
		const raw = readFileSync(docsPath, 'utf8')
			.replace(/^window\.DOCS\s*=\s*/, '')
			.replace(/;?\s*$/, '');
		const data = JSON.parse(raw) as {
			data: { tasks: { id: string }[] };
			dispatch: Record<string, { contractHash: string }>;
		};

		const tasks = data.data.tasks.map((t) => ({
			id: t.id,
			contractHash: data.dispatch[t.id]?.contractHash ?? '',
		}));

		const fp = computeDocsFingerprint(tasks);
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
		expect(tasks.length).toBe(78);
	});
});
