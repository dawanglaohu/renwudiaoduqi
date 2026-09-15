import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { resolveWebDistPath, staticPlugin } from '../../src/http/plugins/80-static.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(currentDir, '../../../web/dist');

describe('daemon static hosting of packages/web/dist (M10-T4 R2)', () => {
	it('resolves source layout to packages/web/dist without cwd fallback', () => {
		const resolved = resolveWebDistPath();
		expect(resolved).toBe(distDir);
	});

	it('serves /index.html, /assets/*, and /fonts/* with bytes matching dist', async () => {
		const app = Fastify({ logger: false });
		await app.register(staticPlugin);
		await app.ready();

		try {
			const indexRes = await app.inject({ method: 'GET', url: '/index.html' });
			expect(indexRes.statusCode).toBe(200);
			expect(indexRes.body).toBe(readFileSync(join(distDir, 'index.html'), 'utf8'));

			const cssName = readdirSync(join(distDir, 'assets')).find((name) => name.endsWith('.css'));
			expect(cssName).toBeDefined();
			const cssRes = await app.inject({ method: 'GET', url: `/assets/${cssName}` });
			expect(cssRes.statusCode).toBe(200);
			expect(cssRes.body).toBe(readFileSync(join(distDir, 'assets', cssName ?? ''), 'utf8'));

			const fontName = 'commit-mono-latin-400.woff2';
			const fontRes = await app.inject({ method: 'GET', url: `/fonts/${fontName}` });
			expect(fontRes.statusCode).toBe(200);
			expect(Buffer.from(fontRes.rawPayload)).toEqual(
				readFileSync(join(distDir, 'fonts', fontName)),
			);
		} finally {
			await app.close();
		}
	});
});
