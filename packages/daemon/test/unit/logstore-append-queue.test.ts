import { describe, expect, it } from 'vitest';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';

describe('AppendQueue', () => {
	it('serializes appends in order and tracks pending bytes', async () => {
		const order: number[] = [];
		const queue = createAppendQueue({
			appendFile: async (_path, data) => {
				await new Promise((r) => setTimeout(r, 5));
				order.push(Number(data[0]));
			},
		});

		const p1 = queue.append('/tmp/a', new Uint8Array([1]));
		const p2 = queue.append('/tmp/a', new Uint8Array([2]));
		expect(queue.pendingBytes).toBe(2);
		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
		expect(queue.pendingBytes).toBe(0);
	});

	it('survives a failed append and keeps the chain alive', async () => {
		const queue = createAppendQueue({
			appendFile: async (_path, data) => {
				if (data[0] === 2) throw new Error('disk gone');
			},
		});
		await expect(queue.append('/a', new Uint8Array([1]))).resolves.toBeUndefined();
		await expect(queue.append('/a', new Uint8Array([2]))).rejects.toThrow('disk gone');
		await expect(queue.append('/a', new Uint8Array([3]))).resolves.toBeUndefined();
	});
});
