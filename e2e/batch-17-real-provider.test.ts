import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type {
	ListAgentModelsResponse,
	ListAgentsResponse,
} from '@agent-scheduler/shared/api/agents';
import type { GateDto } from '@agent-scheduler/shared/api/gates';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILT_IN_AGENT_DEFAULTS } from '../packages/daemon/src/config/defaults.ts';
import { createCodexSessionRegistry } from '../packages/daemon/src/adapters/codex/app-server-session.ts';
import { buildCodexLaunchSpec } from '../packages/daemon/src/adapters/codex/build-launch-spec.ts';
import { spawnManaged } from '../packages/daemon/src/proc/spawn.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const servedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
	cwd: root,
	encoding: 'utf8',
}).trim();
const cleanAtStart =
	execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
const plan = resolve(
	root,
	process.env.R17_EVIDENCE_ROOT ?? '../.codex-plans/agent-scheduler-r17-t73118308',
);
mkdirSync(plan, { recursive: true });
const evidence = mkdtempSync(join(plan, 'provider-'));
const validModel = process.env.R17_REAL_MODEL ?? 'gpt-6.1-sol';
const invalidModel = 'r17-model-that-does-not-exist';
let daemon: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let origin = '';
let token = '';
let code = '';
let daemonLog = '';
const events: EventEnvelope[] = [];
const requests: { method: string; path: string; query: string; body: unknown }[] = [];
const errors: string[] = [];
const frames: string[] = [];
const observations: Record<string, unknown> = {};
const densities: unknown[] = [];
const abort = new AbortController();
let subscription: Promise<void> | undefined;

function redact(text: string): string {
	let clean = text.replace(/(Initial pairing code:\s*)\S+/gi, '$1[REDACTED]');
	for (const secret of [token, code]) if (secret) clean = clean.split(secret).join('[REDACTED]');
	return clean
		.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s"<>@]+:[^/\s"<>@]+@/gi, '$1[REDACTED]@')
		.replace(
			/("(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)"\s*:\s*")(?:\\.|[^"\\])*(")/gi,
			'$1[REDACTED]$2',
		);
}

function privateLogRows(currentPage: Page) {
	return [
		currentPage
			.locator('[data-log-line]')
			.filter({ hasText: '"method":"account/rateLimits/updated"' }),
		currentPage.locator('[data-log-line]').filter({
			hasText: /[a-z][a-z0-9+.-]*:\/\/[^/\s"<>@]+:[^/\s"<>@]+@/i,
		}),
		currentPage.locator('[data-log-line]').filter({
			hasText: /"(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)"\s*:/i,
		}),
	];
}

async function port(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No loopback port');
	await new Promise<void>((done) => server.close(() => done()));
	return address.port;
}

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${origin}/api/v1${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.status).toBe(200);
	return res.json() as Promise<T>;
}

function response(method: string, path: string) {
	if (!page) throw new Error('Browser not ready');
	return page.waitForResponse(
		(res) => res.request().method() === method && new URL(res.url()).pathname === `/api/v1${path}`,
	);
}

async function shot(label: string) {
	if (!page) throw new Error('Browser not ready');
	const style = await page.locator('body').evaluate((element) => ({
		fontFamily: getComputedStyle(element).fontFamily,
		backgroundColor: getComputedStyle(element).backgroundColor,
		pageToken: getComputedStyle(document.documentElement).getPropertyValue('--page').trim(),
	}));
	expect(style.fontFamily).toContain('Public Sans');
	expect(style.pageToken).not.toBe('');
	expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
	observations[`style:${label}`] = style;
	const directory = join(evidence, 'frames');
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${String(frames.length).padStart(2, '0')}-${label}.png`);
	await page.screenshot({
		path,
		mask: privateLogRows(page),
	});
	frames.push(path);
}

async function showNativeLogResult(query: string, rowPattern: RegExp) {
	const currentPage = page;
	if (!currentPage) throw new Error('Browser not ready');
	await currentPage.getByTestId('whole-session-search-input').fill(query);
	await currentPage.locator('[data-action="search-whole-session"]').click();
	await expect
		.poll(async () =>
			Number.parseInt(await currentPage.getByTestId('search-hits-count').innerText(), 10),
		)
		.toBeGreaterThan(0);
	const scroll = currentPage.locator(
		'[data-component="run-detail-container"] [data-virtual-scroll="true"]',
	);
	await scroll.hover();
	await expect
		.poll(async () => {
			await currentPage.mouse.wheel(0, 100_000);
			return scroll.evaluate(
				(element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
			);
		})
		.toBe(true);
	const result = currentPage.locator('[data-log-line]').filter({ hasText: rowPattern });
	await expect.poll(() => result.count()).toBe(1);
	await result.scrollIntoViewIfNeeded();
	expect(await result.isVisible()).toBe(true);
}

async function manualModel(scope: Locator, value: string) {
	if (!page) throw new Error('Browser not ready');
	await scope.getByRole('combobox').click();
	await page.getByRole('option', { name: '手填模型名…', exact: true }).click();
	await page.getByTestId('grouped-select-custom-input').fill(value);
	await page.getByTestId('grouped-select-custom-input').press('Enter');
}

async function density(label: string, type: 'work' | 'form', pad = 14) {
	if (!page) throw new Error('Browser not ready');
	const source = readFileSync(
		join(root, 'docs/Agent任务调度器-开发文档/_run/density_probe.js'),
		'utf8',
	);
	for (const viewport of [
		{ width: 1920, height: 1080 },
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
	]) {
		await page.setViewportSize(viewport);
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		const result = await page.evaluate(
			({ source, type, pad }) => {
				(0, eval)(source);
				return (
					globalThis as unknown as {
						densityProbe(options: { type: string; density: number; pad: number }): {
							verdict: { pass: boolean };
						};
					}
				).densityProbe({ type, density: 8, pad });
			},
			{ source, type, pad },
		);
		densities.push({ label, viewport, result });
		expect(result.verdict.pass).toBe(true);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
}

async function subscribe() {
	const res = await fetch(`${origin}/api/v1/events`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: abort.signal,
	});
	expect(res.status).toBe(200);
	if (!res.body) throw new Error('No live SSE body');
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	subscription = (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let end = buffer.indexOf('\n\n');
				while (end >= 0) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = frame
						.split('\n')
						.filter((line) => line.startsWith('data:'))
						.map((line) => line.slice(5).trim())
						.join('\n');
					if (data) events.push(JSON.parse(data) as EventEnvelope);
					end = buffer.indexOf('\n\n');
				}
			}
		} catch (error) {
			if (!abort.signal.aborted) throw error;
		} finally {
			reader.releaseLock();
		}
	})();
}

async function latestGate(taskId: string): Promise<GateDto> {
	let gate: GateDto | undefined;
	await expect
		.poll(
			async () => {
				gate = (await get<{ gates: GateDto[] }>('/gates')).gates
					.filter((item) => item.taskId === taskId && item.state === 'waiting')
					.at(-1);
				return (
					gate?.context?.stderrTail?.kind === 'lines' &&
					Boolean(gate.context.login?.checkedAt) &&
					events.some((event) => event.kind === 'run.exited' && event.runId === gate?.runId)
				);
			},
			{ timeout: 180_000, interval: 250 },
		)
		.toBe(true);
	if (!gate) throw new Error('No final zero-output gate');
	return gate;
}

afterAll(async () => {
	abort.abort();
	await subscription;
	if (page) {
		await page
			.screenshot({
				path: join(evidence, 'final.png'),
				mask: [page.getByTestId('pairing-code-input'), ...privateLogRows(page)],
			})
			.catch(() => undefined);
	}
	writeFileSync(
		join(evidence, 'evidence.json'),
		redact(
			JSON.stringify(
				{
					origin,
					head: servedHead,
					headAtEnd: execFileSync('git', ['rev-parse', 'HEAD'], {
						cwd: root,
						encoding: 'utf8',
					}).trim(),
					tree: root,
					cleanAtStart,
					mode: 'production bootstrap; ordinary registry; real native transport; fresh touch-capable Chromium context; account rate-limit and credential-bearing log rows masked in screenshots',
					validModel,
					invalidModel,
					events,
					requests,
					errors,
					frames,
					observations,
					densities,
				},
				null,
				2,
			),
		),
	);
	writeFileSync(join(evidence, 'daemon.log'), redact(daemonLog));
	await browser?.close();
	if (daemon && daemon.exitCode === null) {
		const exited = new Promise<void>((done) => daemon?.once('exit', () => done()));
		daemon.kill('SIGTERM');
		const timer = setTimeout(() => daemon?.kill('SIGKILL'), 5000);
		await exited;
		clearTimeout(timer);
	}
	console.log(`Real-provider evidence: ${evidence}`);
});

describe('R17-T73118308 real native provider', () => {
	it('honors the configured budget while a real native process is descheduled for 16s', async () => {
		expect(cleanAtStart).toBe(true);
		expect(process.platform).toBe('linux');
		const native = spawnManaged(
			buildCodexLaunchSpec({
				runId: 'r17-cold-start',
				cwd: evidence,
				execPath: process.env.R17_CODEX_EXEC_PATH,
				model: validModel,
				permissionTier: 'workspaceWrite',
				effortTier: 'low',
				timeouts: { startupTimeoutMs: 60_000 },
			}),
			{ platform: 'linux' },
		);
		const chunks: string[] = [];
		native.onJson(({ value }) => {
			if (
				value &&
				typeof value === 'object' &&
				'method' in value &&
				value.method === 'item/agentMessage/delta' &&
				'params' in value &&
				value.params &&
				typeof value.params === 'object' &&
				'delta' in value.params &&
				typeof value.params.delta === 'string'
			)
				chunks.push(value.params.delta);
		});
		const exited = new Promise<void>((done) => native.onExit(() => done()));
		const session = createCodexSessionRegistry().register('r17-cold-start', native);
		process.kill(native.pid, 'SIGSTOP');
		const resume = setTimeout(() => process.kill(native.pid, 'SIGCONT'), 16_000);
		try {
			await session.start({
				prompt: 'Reply with exactly R17-CONTROL. Do not use tools.',
				model: validModel,
				sandbox: 'workspace-write',
			});
			await expect.poll(() => chunks.join(''), { timeout: 90_000 }).toBe('R17-CONTROL');
			await exited;
			writeFileSync(
				join(evidence, 'cold-start.json'),
				JSON.stringify({
					descheduledMs: 16_000,
					startupBudgetMs: native.timers.startupTimeoutMs,
					chunks,
					exit: native.exitResult,
				}),
			);
		} finally {
			clearTimeout(resume);
			if (!native.isExited) process.kill(native.pid, 'SIGCONT');
			if (!native.isExited) await native.kill();
			session.dispose();
		}
	}, 150_000);
	it('production bootstrap → UI pairing/import/assignment → valid content → invalid model → recovery', async () => {
		expect(cleanAtStart).toBe(true);
		const data = process.env.R17_DATA_ROOT
			? join(process.env.R17_DATA_ROOT, basename(evidence))
			: join(evidence, 'data');
		const project = join(evidence, 'project');
		mkdirSync(data);
		mkdirSync(project);
		const execPath = process.env.R17_CODEX_EXEC_PATH;
		writeFileSync(
			join(data, 'agents.json'),
			JSON.stringify({
				schemaVersion: 1,
				defaults: BUILT_IN_AGENT_DEFAULTS,
				overrides: execPath ? { codex: { execPath } } : {},
			}),
		);
		const doc = JSON.parse(
			readFileSync(join(root, 'e2e/fixtures/docs-data.js'), 'utf8')
				.replace(/^\s*window\.DOCS\s*=\s*/, '')
				.replace(/;\s*$/, ''),
		);
		doc.project = '真实供应商生产验收';
		doc.pres.handoff.repo = project;
		doc.handoff.contracts = {};
		doc.handoff.readiness = {};
		doc.handoff.effectivePaths = {};
		doc.dispatch = {};
		doc.data.tasks = [1, 2].map((n) => {
			const id = `R17-P${n}`,
				hash = `r17-provider-${n}`,
				paths = [`proof-${n}.txt`];
			doc.handoff.contracts[id] = { hash, effectivePaths: paths };
			doc.handoff.readiness[id] = { ready: true, contractHash: hash, reasons: [] };
			doc.handoff.effectivePaths[id] = paths;
			doc.dispatch[id] = {
				contractHash: hash,
				implementation: 'Reply with exactly R17-CONTROL. Do not use tools or change files.',
				review: 'Read the result and report VERDICT pass or VERDICT rework.',
			};
			return {
				id,
				title: n === 1 ? '合法模型内容控制' : '错误模型零产出恢复',
				module: 'M1',
				deps: [],
				input: 'Isolated production acceptance',
				output: paths[0],
				accept: '1) Produce content through the real native provider.',
				est: 0.1,
				edges: ['E-348'],
			};
		});
		writeFileSync(join(project, 'docs-data.js'), `window.DOCS = ${JSON.stringify(doc)};\n`);
		for (const args of [
			['init', project],
			['-C', project, 'symbolic-ref', 'HEAD', 'refs/heads/main'],
			['-C', project, 'add', 'docs-data.js'],
			[
				'-C',
				project,
				'-c',
				'user.name=Provider acceptance',
				'-c',
				'user.email=evidence@example.invalid',
				'commit',
				'-m',
				'Acceptance input',
			],
		])
			execFileSync('git', args, { stdio: 'ignore' });
		origin = `http://127.0.0.1:${await port()}`;
		const bootstrapStartedAt = performance.now();
		daemon = spawn(process.execPath, [join(root, 'packages/daemon/bootstrap.mjs')], {
			cwd: root,
			env: {
				...process.env,
				AGSCHED_DATA_DIR: data,
				AGSCHED_PORT: new URL(origin).port,
				AGSCHED_BIND: '127.0.0.1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		daemon.stdout?.on('data', (chunk) => {
			daemonLog += String(chunk);
		});
		daemon.stderr?.on('data', (chunk) => {
			daemonLog += String(chunk);
		});
		await expect
			.poll(
				() => {
					if (daemon?.exitCode !== null)
						throw new Error(redact(`Production bootstrap exited: ${daemonLog}`));
					return existsSync(join(data, 'pairing-code.txt'));
				},
				{ timeout: 30_000 },
			)
			.toBe(true);
		observations.bootstrap = {
			pid: daemon.pid,
			readinessMs: performance.now() - bootstrapStartedAt,
			node: process.versions.node,
			platform: process.platform,
		};
		code = readFileSync(join(data, 'pairing-code.txt'), 'utf8').trim();
		expect(statSync(join(data, 'pairing-code.txt')).mode & 0o777).toBe(0o600);
		observations.pairingFile = { directory: data, mode: '0600' };
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			hasTouch: true,
		});
		page = await context.newPage();
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('request', (request) => {
			const url = new URL(request.url());
			if (url.pathname.startsWith('/api/v1/') && !url.pathname.includes('/pair/'))
				requests.push({
					method: request.method(),
					path: url.pathname,
					query: url.search,
					body: request.postData() ? request.postDataJSON() : null,
				});
		});
		await page.goto(origin, { waitUntil: 'domcontentloaded' });
		await page.getByTestId('pairing-code-input').waitFor();
		expect(page.url()).toBe(`${origin}/#/pair`);
		await shot('pair');
		await page.getByTestId('pairing-code-input').fill(code);
		const claim = response('POST', '/pair/claim');
		await page.getByTestId('pairing-submit-button').click();
		token = (await (await claim).json()).token;
		expect(token).toBeTruthy();
		await page.waitForURL(`${origin}/#/`);
		expect(existsSync(join(data, 'pairing-code.txt'))).toBe(false);
		await subscribe();
		await page.goto(`${origin}/#/settings/agents`, { waitUntil: 'domcontentloaded' });
		const card = page.getByTestId('agent-card-codex');
		await card.waitFor();
		const initialCatalog = await get<ListAgentModelsResponse>('/agents/codex/models');
		const initialAgent = (await get<ListAgentsResponse>('/agents')).agents.find(
			(agent) => agent.id === 'codex',
		);
		const before = requests.length;
		const refreshed = page.waitForResponse(
			(res) =>
				new URL(res.url()).pathname === '/api/v1/agents/codex/models' &&
				new URL(res.url()).search === '?refresh=1',
		);
		await card.getByTestId('refresh-models-btn-codex').click();
		const refreshedResponse = await refreshed;
		expect(refreshedResponse.status()).toBe(200);
		const catalog: ListAgentModelsResponse = await refreshedResponse.json();
		await expect.poll(() => card.getByTestId('refresh-models-btn-codex').isEnabled()).toBe(true);
		expect(requests.slice(before).filter((r) => r.query === '?refresh=1')).toHaveLength(1);
		const refreshedAgent = (await get<ListAgentsResponse>('/agents')).agents.find(
			(agent) => agent.id === 'codex',
		);
		expect(refreshedAgent?.login?.checkedAt).toBeTruthy();
		expect(refreshedAgent?.login?.checkedAt).not.toBe(initialAgent?.login?.checkedAt);
		expect(await card.getByTestId('login-badge').getAttribute('title')).toBe('刚刚');
		expect(catalog.models.some((model) => model.source === 'config')).toBe(true);
		await card.getByTestId('model-picker').getByRole('combobox').click();
		const menu = page.getByTestId('grouped-select-content');
		expect(await menu.innerText()).toContain('配置文件');
		expect(await menu.innerText()).toContain('当前配置');
		for (const provider of new Set(catalog.models.map((model) => model.provider).filter(Boolean)))
			expect(await menu.innerText()).toContain(provider);
		await shot('catalog-groups');
		await page.keyboard.press('Escape');
		observations.catalog = {
			initialCatalog,
			catalog,
			initialLogin: initialAgent?.login,
			refreshedLogin: refreshedAgent?.login,
		};
		await density('agents', 'work', 18);
		await shot('refreshed');
		const setting = response('PATCH', '/agents/codex');
		await manualModel(card.getByTestId('model-picker'), validModel);
		expect((await setting).status()).toBe(200);
		await expect
			.poll(() => card.getByTestId('layer-override-defaultModel').innerText())
			.toContain(validModel);
		await context.setOffline(true);
		const failedRestore = page.waitForEvent('requestfailed', {
			predicate: (request) =>
				request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/v1/agents/codex',
		});
		await card.getByTestId('restore-default-defaultModel-codex').click();
		await failedRestore;
		expect(await card.getByTestId('layer-override-defaultModel').innerText()).toContain(validModel);
		const reconnectStart = requests.length;
		await context.setOffline(false);
		const restore = response('PATCH', '/agents/codex');
		await card.getByTestId('restore-default-defaultModel-codex').click();
		expect((await restore).request().postDataJSON()).toEqual({ clearOverrides: ['defaultModel'] });
		await expect
			.poll(() => card.getByTestId('restore-default-defaultModel-codex').isDisabled())
			.toBe(true);
		expect(
			requests
				.slice(reconnectStart)
				.filter((request) => request.method === 'GET' && request.path.endsWith('/models'))
				.every((request) => request.query === ''),
		).toBe(true);
		await card.getByTestId('effort-picker').getByRole('combobox').click();
		await shot('effort-options');
		const effort = response('PATCH', '/agents/codex');
		await page.getByRole('option', { name: '低档 (low)', exact: true }).click();
		expect((await effort).status()).toBe(200);
		await expect
			.poll(() => card.getByTestId('layer-override-defaultEffortTier').innerText())
			.toBe('低');
		const effortOverride = await card.getByTestId('layer-override-defaultEffortTier').innerText();
		await context.setOffline(true);
		const failedEffortRestore = page.waitForEvent('requestfailed', {
			predicate: (request) =>
				request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/v1/agents/codex',
		});
		await card.getByTestId('restore-default-defaultEffortTier-codex').click();
		await failedEffortRestore;
		await expect
			.poll(() => card.getByTestId('restore-default-defaultEffortTier-codex').isEnabled())
			.toBe(true);
		expect(await card.getByTestId('layer-override-defaultEffortTier').innerText()).toBe(
			effortOverride,
		);
		await context.setOffline(false);
		const restoredEffort = response('PATCH', '/agents/codex');
		await card.getByTestId('restore-default-defaultEffortTier-codex').click();
		expect((await restoredEffort).request().postDataJSON()).toEqual({
			clearOverrides: ['defaultEffortTier'],
		});
		await expect
			.poll(() => card.getByTestId('restore-default-defaultEffortTier-codex').isDisabled())
			.toBe(true);
		const restoredAgent = (await get<ListAgentsResponse>('/agents')).agents.find(
			(agent) => agent.id === 'codex',
		);
		expect(restoredAgent?.layers?.defaultModel.hasOverride).toBe(false);
		expect(restoredAgent?.layers?.defaultEffortTier.hasOverride).toBe(false);
		observations.restoredAgent = restoredAgent;
		await shot('defaults-restored');
		await page.goto(`${origin}/#/settings/pipeline`, { waitUntil: 'domcontentloaded' });
		const pipeline = page.locator('[data-component="pipeline-toggles"][data-layout="settings"]');
		await expect
			.poll(() => page?.getByTestId('wrapup-assignment-custom-btn').isEnabled())
			.toBe(true);
		const network = await context.newCDPSession(page);
		await network.send('Network.enable');
		await network.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 300,
			downloadThroughput: -1,
			uploadThroughput: -1,
		});
		const pipelinePatch = response('PATCH', '/settings/pipeline');
		await page.getByTestId('wrapup-assignment-custom-btn').click();
		await expect.poll(() => pipeline.getAttribute('data-pending')).toBe('true');
		expect(await page.getByTestId('review-override-custom-btn').isDisabled()).toBe(true);
		await shot('pipeline-pending');
		const pipelineResponse = await pipelinePatch;
		expect(pipelineResponse.status()).toBe(200);
		expect(Object.keys(pipelineResponse.request().postDataJSON()).sort()).toEqual([
			'bughunt',
			'reviewOverride',
			'wrapupAssignment',
			'wrapupMode',
		]);
		await expect
			.poll(() => events.some((event) => event.kind === 'settings.pipeline_changed'))
			.toBe(true);
		await expect.poll(() => pipeline.getAttribute('data-pending')).toBe('false');
		const followPatch = response('PATCH', '/settings/pipeline');
		await page.getByTestId('wrapup-assignment-follow-btn').click();
		expect((await followPatch).status()).toBe(200);
		await expect.poll(() => pipeline.getAttribute('data-pending')).toBe('false');
		await network.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1,
		});
		await network.detach();
		await density('pipeline', 'form', 18);
		await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
		await page.getByTestId('import-doc-path').fill(join(project, 'docs-data.js'));
		const importing = response('POST', '/documents');
		await page.locator('[data-action="import-document"]').click();
		const docId = (await (await importing).json()).document.id;
		await page.locator(`[data-doc-id="${docId}"]`).click();
		await page.locator('[data-action="next-step-1"]').click();
		const batchId = (await get<{ batches: { id: string }[] }>(`/documents/${docId}/batches`))
			.batches[0]?.id;
		expect(batchId).toBeTruthy();
		await page.locator(`[data-step-content="1"] [data-batch-id="${batchId}"]`).click();
		await page.locator('[data-action="next-step-2"]').click();
		for (const n of [1, 2]) await page.getByTestId(`select-agent-R17-P${n}`).selectOption('codex');
		const firstModel = page.getByTestId('editing-row-R17-P1').getByTestId('model-picker');
		const secondModel = page.getByTestId('editing-row-R17-P2').getByTestId('model-picker');
		await expect.poll(() => firstModel.getByRole('combobox').isEnabled()).toBe(true);
		const refreshStart = requests.length;
		const sharedRefresh = page.waitForResponse(
			(res) =>
				new URL(res.url()).pathname === '/api/v1/agents/codex/models' &&
				new URL(res.url()).search === '?refresh=1',
		);
		const firstRefresh = page
			.getByTestId('editing-row-R17-P1')
			.locator('[data-action="refresh-agent-models"]');
		const secondRefresh = page
			.getByTestId('editing-row-R17-P2')
			.locator('[data-action="refresh-agent-models"]');
		await firstRefresh.click();
		expect(await firstRefresh.isDisabled()).toBe(true);
		expect(await secondRefresh.isDisabled()).toBe(true);
		await secondModel.getByRole('combobox').click();
		expect(await page.getByTestId('grouped-select-content').innerText()).toContain(
			catalog.currentConfig.model,
		);
		await page.keyboard.press('Escape');
		expect((await sharedRefresh).status()).toBe(200);
		await expect.poll(() => secondRefresh.isEnabled()).toBe(true);
		expect(
			requests.slice(refreshStart).filter((request) => request.query === '?refresh=1'),
		).toHaveLength(1);
		for (const n of [1, 2]) {
			const row = page.getByTestId(`editing-row-R17-P${n}`);
			await row.getByTestId(`select-agent-R17-P${n}`).selectOption('codex');
			await expect
				.poll(() => row.getByTestId('model-picker').getByRole('combobox').isEnabled())
				.toBe(true);
			await manualModel(row.getByTestId('model-picker'), n === 1 ? validModel : invalidModel);
			await row.getByTestId('effort-picker').getByRole('combobox').click();
			await page.getByRole('option', { name: '低档 (low)', exact: true }).click();
			const assigned = response('POST', `/batches/${batchId}/assignments`);
			await row.locator('[data-action="confirm-task-assign"]').click();
			expect((await assigned).status()).toBe(200);
		}
		await shot('assigned');
		await page.locator('[data-action="next-step-3"]').click();
		for (const [key, label] of [
			['dispatch', '自动'],
			['review', '等我确认'],
			['landing', '等我确认'],
		]) {
			const button = page
				.locator(`[data-gate-toggle="${key}"]`)
				.getByRole('button', { name: label, exact: true });
			if ((await button.getAttribute('aria-pressed')) !== 'true') {
				await button.click();
				await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
			}
		}
		const started = response('POST', `/batches/${batchId}/start`);
		await page.locator('[data-action="confirm-dispatch"]').click();
		expect((await started).ok()).toBe(true);
		await expect
			.poll(
				() =>
					events
						.flatMap((e) =>
							e.kind === 'agent_message_chunk' && 'chunk' in e.payload ? [e.payload.chunk] : [],
						)
						.join(''),
				{ timeout: 180_000 },
			)
			.toContain('R17-CONTROL');
		const runs = (await get<{ runs: RunDto[] }>('/runs')).runs;
		const control = runs.find((run) => run.modelName === validModel && run.kind === 'implement');
		expect(control).toBeDefined();
		await expect
			.poll(
				() => events.some((event) => event.kind === 'run.exited' && event.runId === control?.id),
				{ timeout: 180_000 },
			)
			.toBe(true);
		await page.goto(`${origin}/#/run/${control?.id}`, { waitUntil: 'domcontentloaded' });
		await page.getByTestId('run-detail-page').waitFor();
		await showNativeLogResult(
			'R17-CONTROL',
			/"method":"item\/completed".*"type":"agentMessage".*"text":"R17-CONTROL"/,
		);
		await shot('control-content');
		await page.getByRole('button', { name: '返回甲板', exact: true }).click();
		let failed: RunDto | undefined;
		await expect
			.poll(
				async () => {
					failed = (await get<{ runs: RunDto[] }>('/runs')).runs.find(
						(run) => run.modelName === invalidModel,
					);
					return failed?.state;
				},
				{ timeout: 180_000 },
			)
			.toBe('awaiting_human');
		if (!failed?.taskId) throw new Error('Invalid-model task missing');
		const gate = await latestGate(failed.taskId);
		observations.invalidModelGate = gate;
		expect(gate.comment).toBe('exited_before_output');
		expect(
			events.filter(
				(e) =>
					e.runId === failed?.id &&
					['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(e.kind),
			),
		).toHaveLength(0);
		expect(
			events
				.filter((e) => e.runId === failed?.id && e.kind === 'run.stderr_line')
				.map((e) => JSON.stringify(e.payload))
				.join('\n'),
		).toMatch(/model.{0,80}(not supported|not found|does not exist|invalid|unavailable)/i);
		const gateCard = page.locator('[data-component="gate-card"]').filter({ hasText: 'R17-P2' });
		await gateCard.getByRole('button', { name: '重跑', exact: true }).waitFor();
		expect(await gateCard.innerText()).toContain(
			'agent 未产出任何内容就退出，常见原因：未登录、模型名不可用、参数被拒',
		);
		await expect.poll(() => gateCard.innerText()).not.toContain('事件缺失');
		await expect.poll(() => gateCard.getByTestId('login-badge').getAttribute('title')).toBe('刚刚');
		await density('deck', 'work');
		await shot('invalid-model-gate');
		await page.goto(`${origin}/#/run/${failed.id}`, { waitUntil: 'domcontentloaded' });
		await showNativeLogResult('not supported', /"method":"error".*model.{0,80}not supported/i);
		await shot('model-error-detail');
		await page.getByRole('button', { name: '返回甲板', exact: true }).click();
		await gateCard.getByRole('button', { name: '重跑', exact: true }).waitFor();
		const rerun = response('POST', `/runs/${failed.id}/rerun`);
		await gateCard.getByRole('button', { name: '重跑', exact: true }).click();
		const rerunId = (await (await rerun).json()).run.id;
		await expect
			.poll(() => events.some((e) => e.kind === 'run.exited' && e.runId === rerunId), {
				timeout: 180_000,
			})
			.toBe(true);
		await latestGate(failed.taskId);
		await gateCard.locator(`a[href="#/run/${rerunId}"]`).waitFor();
		await gateCard.getByRole('button', { name: '换 agent 重派', exact: true }).click();
		const selector = page.getByTestId('select-agent-R17-P2');
		observations.reassignFocus = await selector.evaluate((element) => ({
			active: document.activeElement?.outerHTML,
			target: element.outerHTML,
			visible: element.getBoundingClientRect().toJSON(),
		}));
		await expect
			.poll(() => selector.evaluate((element) => element === document.activeElement), {
				timeout: 5_000,
			})
			.toBe(true);
		expect(await selector.inputValue()).toBe('codex');
		await shot('reassign-focus');
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator('[data-pane-tab="tasks"]').click();
		await gateCard.getByRole('button', { name: '重跑', exact: true }).waitFor();
		await gateCard.getByRole('button', { name: '重跑', exact: true }).scrollIntoViewIfNeeded();
		expect(await gateCard.isVisible()).toBe(true);
		expect(await gateCard.getAttribute('data-tier')).toMatch(/^phone/);
		expect(await gateCard.getByRole('button', { name: '标失败', exact: true }).count()).toBe(1);
		await expect
			.poll(() =>
				gateCard
					.locator('button')
					.filter({ hasText: /^\s*换 agent 重派\s*$/ })
					.count(),
			)
			.toBe(0);
		await expect
			.poll(() => page?.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
			.toBe(true);
		await page.screenshot({ path: join(evidence, 'phone-gate.png') });
		await page.setViewportSize({ width: 1440, height: 900 });
		await gateCard.getByRole('button', { name: '换 agent 重派', exact: true }).waitFor();
		const reassignRow = page.getByTestId('editing-row-R17-P2');
		await manualModel(reassignRow.getByTestId('model-picker'), invalidModel);
		await reassignRow.getByTestId('effort-picker').getByRole('combobox').click();
		await page.getByRole('option', { name: '低档 (low)', exact: true }).click();
		const reassigned = response('POST', '/runs');
		await reassignRow.locator('[data-action="confirm-task-assign"]').click();
		const reassignResponse = await reassigned;
		expect(reassignResponse.status()).toBe(200);
		expect(reassignResponse.request().postDataJSON()).toMatchObject({
			agentId: 'codex',
			model: invalidModel,
			effort: { tier: 'low' },
		});
		const reassignedRun: RunDto = (await reassignResponse.json()).run;
		expect(reassignedRun.modelName).toBe(invalidModel);
		const reassignedId = reassignedRun.id;
		await expect
			.poll(
				() => events.some((event) => event.kind === 'run.exited' && event.runId === reassignedId),
				{ timeout: 180_000 },
			)
			.toBe(true);
		await latestGate(failed.taskId);
		await gateCard.locator(`a[href="#/run/${reassignedId}"]`).waitFor();
		observations.reassign = {
			rerunId,
			reassignedId,
			retainedAgent: 'codex',
			contract: 'E-359 permits dispatch without changing agent',
		};
		await shot('reassigned-gate');
		await gateCard.getByRole('button', { name: '标失败', exact: true }).click();
		await page.getByTestId('reject-confirm-dialog').waitFor();
		await expect
			.poll(() =>
				page
					?.getByTestId('cancel-reject')
					.evaluate((element) => element === document.activeElement),
			)
			.toBe(true);
		await page.getByTestId('cancel-reject').click();
		expect(
			(await get<{ runs: RunDto[] }>('/runs')).runs.find((run) => run.id === reassignedId)?.state,
		).toBe('awaiting_human');
		await gateCard.getByRole('button', { name: '标失败', exact: true }).click();
		await page.getByTestId('confirm-reject').click();
		await expect
			.poll(
				async () =>
					(await get<{ runs: RunDto[] }>('/runs')).runs.find((run) => run.id === reassignedId)
						?.state,
			)
			.toBe('failed');
		await expect.poll(() => gateCard.count(), { timeout: 10_000 }).toBe(0);
		await shot('failed-card-removed');
		await page.goto(`${origin}/#/run/${reassignedId}`, { waitUntil: 'domcontentloaded' });
		await expect
			.poll(() =>
				page?.locator('[data-component="run-detail-container"]').getAttribute('data-run-state'),
			)
			.toBe('failed');
		await shot('failed-run-detail');
		observations.failedDetailState = await page
			.locator('[data-component="run-detail-container"]')
			.getAttribute('data-run-state');
		await page.getByRole('button', { name: '返回甲板', exact: true }).click();
		await expect.poll(() => gateCard.count()).toBe(0);
		await page.locator(`[data-doc-id="${docId}"]`).click();
		await page.locator('[data-action="next-step-1"]').click();
		await page.locator(`[data-step-content="1"] [data-batch-id="${batchId}"]`).click();
		await page.locator('[data-action="next-step-2"]').click();
		const failedTaskState = page.locator(
			`[data-task-id="${failed.taskId}"] [role="status"][data-state="failed"]`,
		);
		await failedTaskState.waitFor();
		await expect.poll(() => gateCard.count()).toBe(0);
		observations.finalConvergence = {
			runId: reassignedId,
			apiState: (await get<{ runs: RunDto[] }>('/runs')).runs.find((run) => run.id === reassignedId)
				?.state,
			deckTaskState: await failedTaskState.getAttribute('data-state'),
			remainingZeroOutputCards: await gateCard.count(),
		};
		expect(errors).toEqual([]);
		const modelRequests = requests.filter(
			(request) => request.method === 'GET' && request.path.endsWith('/models'),
		);
		expect(modelRequests.filter((request) => request.query === '?refresh=1')).toHaveLength(2);
		expect(modelRequests.filter((request) => request.query === '').length).toBeGreaterThan(0);
		expect(
			modelRequests.every((request) => request.query === '' || request.query === '?refresh=1'),
		).toBe(true);
		await shot('confirmed-failure');
	}, 900_000);
});
