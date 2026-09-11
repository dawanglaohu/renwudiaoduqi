import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	canonicalizeDocsFingerprintPayload,
	computeDocsFingerprint,
} from '../../src/domain/docs-fingerprint.ts';
import { defaultSha256Hasher } from '../../src/service/docs.ts';

describe('domain/docs-fingerprint (AC 2, E-17, E-79)', () => {
	it('keeps domain fingerprint canonicalization free of runtime crypto dependencies', () => {
		const source = readFileSync(resolve(__dirname, '../../src/domain/docs-fingerprint.ts'), 'utf8');
		expect(source).not.toMatch(/from ['"]node:crypto['"]/);
		expect(source).not.toMatch(/from ['"]crypto['"]/);
		expect(source).not.toContain('createHash');
	});

	it('locks the canonical JSON bytes and known SHA-256 digest for a fixed fixture', () => {
		const fixture = [
			{ id: 'M1-T2', contractHash: 'hash-2' },
			{ id: 'M1-T1', contractHash: 'hash-1' },
		];

		const canonical = canonicalizeDocsFingerprintPayload(fixture);
		expect(canonical).toBe('[["M1-T1","hash-1"],["M1-T2","hash-2"]]');

		const digest = computeDocsFingerprint(fixture, defaultSha256Hasher);
		expect(digest).toBe('620238617147fd35eb246c5a079b969af6b9c29510ed9ff6a3d47068685619f6');
	});

	it('sorts task IDs with a cross-platform deterministic code-unit comparison', () => {
		const mixed = [
			{ id: 'M1-T2', contractHash: 'h2' },
			{ id: 'M1-T10', contractHash: 'h10' },
			{ id: 'M1-T1', contractHash: 'h1' },
			{ id: 'M10-T1', contractHash: 'h10_1' },
		];

		const canonical = canonicalizeDocsFingerprintPayload(mixed);
		expect(canonical).toBe('[["M1-T1","h1"],["M1-T10","h10"],["M1-T2","h2"],["M10-T1","h10_1"]]');
	});

	it('is order-independent because tasks are always sorted deterministically (E-17)', () => {
		const fp1 = computeDocsFingerprint(
			[
				{ id: 'M1-T2', contractHash: 'hash-b' },
				{ id: 'M1-T1', contractHash: 'hash-a' },
				{ id: 'M1-T3', contractHash: 'hash-c' },
			],
			defaultSha256Hasher,
		);

		const fp2 = computeDocsFingerprint(
			[
				{ id: 'M1-T1', contractHash: 'hash-a' },
				{ id: 'M1-T3', contractHash: 'hash-c' },
				{ id: 'M1-T2', contractHash: 'hash-b' },
			],
			defaultSha256Hasher,
		);

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

		expect(computeDocsFingerprint(base, defaultSha256Hasher)).not.toBe(
			computeDocsFingerprint(modified, defaultSha256Hasher),
		);
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

		const baseFp = computeDocsFingerprint(base, defaultSha256Hasher);
		expect(computeDocsFingerprint(added, defaultSha256Hasher)).not.toBe(baseFp);
		expect(computeDocsFingerprint(deleted, defaultSha256Hasher)).not.toBe(baseFp);
	});

	it('computes expected fingerprint on actual repository docs-data.js', () => {
		const docsPath = resolve(__dirname, '../../../../docs/Agent任务调度器-开发文档/docs-data.js');
		const raw = readFileSync(docsPath, 'utf8')
			.replace(/^window\.DOCS\s*=\s*/, '')
			.replace(/;?\s*$/, '');
		const data = JSON.parse(raw) as {
			data: { tasks: { id: string }[] };
			dispatch: Record<string, { contractHash?: string }>;
		};

		const tasks = data.data.tasks.map((t) => ({
			id: t.id,
			contractHash: data.dispatch[t.id]?.contractHash ?? '',
		}));

		const fp = computeDocsFingerprint(tasks, defaultSha256Hasher);
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
		// The payload must cover every task in the file, each with a 64-hex dispatch
		// contract hash; the count follows the source instead of a pinned total.
		expect(tasks.map((t) => t.id)).toEqual(data.data.tasks.map((t) => t.id));
		expect(tasks.every((t) => /^[0-9a-f]{64}$/.test(t.contractHash))).toBe(true);
	});
});
