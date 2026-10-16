import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type DocumentApi,
	type ListedRun,
	type RunningDaemon,
	apiFor,
	artifactsDir,
	beginEvidence,
	captureFailure,
	chooseAgent,
	claimAdmin,
	commitDocs,
	configureAutoPipeline,
	createRepo,
	executionOf,
	fixturesDir,
	git,
	importThroughPage,
	listRuns,
	mergeBranch,
	openBrowser,
	pairPage,
	readPlan,
	readAgentMessages,
	readResources,
	readRunSnapshot,
	readSnapshotInput,
	readWrapupRows,
	clearRelease,
	releaseAgents,
	renderDocs,
	requestWithoutResponse,
	repoRoot,
	selectVendorEffort,
	setLaneCount,
	startDocumentDaemon,
	waitFor,
	writeControl,
} from './helpers/document-execution-harness.ts';

const active: { daemon: RunningDaemon | null; page: import('playwright').Page | null } = {
	daemon: null,
	page: null,
};

beforeEach((ctx) => beginEvidence(ctx.task.name));

afterEach(async (ctx) => {
	if (ctx.task.result?.state === 'fail' && (active.page || active.daemon)) {
		const name = ctx.task.name.replace(/[^\w.-]+/g, '_').slice(0, 80);
		await captureFailure(active.page, active.daemon, name);
	}
	if (active.daemon && existsSync(active.daemon.dataDir)) releaseAgents(active.daemon, ['all']);
	await active.page?.context().browser()?.close().catch(() => undefined);
	await active.daemon?.stop().catch(() => undefined);
	active.page = null;
	active.daemon = null;
});

async function boot() {
	const daemon = await startDocumentDaemon();
	active.daemon = daemon;
	const token = await claimAdmin(daemon);
	const api = apiFor(daemon, token);
	const browser = await openBrowser();
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	active.page = page;
	const browserToken = await pairPage(page, daemon, token);
	active.daemon = daemon;
	active.page = page;
	return { daemon, api, page, browser, browserToken };
}

async function taskIndex(api: DocumentApi, docId: string) {
	const response = await api.get(`/api/v1/documents/${docId}/tasks`);
	const tasks = response.body.tasks as Array<{ id: string; taskKey: string; batchId: string | null }>;
	return new Map(tasks.map((task) => [task.taskKey, task]));
}

async function batchesOf(api: DocumentApi, docId: string) {
	const response = await api.get(`/api/v1/documents/${docId}/batches`);
	return response.body.batches as Array<{ id: string; batchNo: number; state: string }>;
}

async function visibleText(page: import('playwright').Page, selector: string): Promise<string> {
	const locator = page.locator(selector).first();
	await locator.waitFor({ state: 'visible', timeout: 15000 });
	return locator.innerText();
}

async function documentId(api: DocumentApi): Promise<string> {
	const response = await api.get('/api/v1/documents');
	const documents = response.body.documents as Array<{ id: string }>;
	const id = documents[0]?.id;
	if (!id) throw new Error('Imported document was not listed');
	return id;
}

async function sourceFingerprint(api: DocumentApi, docId: string): Promise<string> {
	const documents = (await api.get('/api/v1/documents')).body.documents as Array<{ id: string; contentFingerprint: string }>;
	const fingerprint = documents.find((doc) => doc.id === docId)?.contentFingerprint;
	if (!fingerprint) throw new Error('Document fingerprint is missing');
	return fingerprint;
}

function occupies(run: ListedRun): boolean {
	return run.kind === 'implement' && ['queued', 'starting', 'running'].includes(run.state);
}

async function mergeWhenReady(repo: string, branch: string): Promise<void> {
	await waitFor(
		`commit on ${branch}`,
		async () => {
			try {
				git(repo, ['merge-base', '--is-ancestor', branch, 'HEAD']);
				return true;
			} catch {
				// The branch is not in HEAD yet.
			}
			try {
				const count = git(repo, ['rev-list', '--count', `main..${branch}`]).trim();
				return count !== '0';
			} catch {
				return false;
			}
		},
		20000,
	);
	try {
		git(repo, ['merge-base', '--is-ancestor', branch, 'HEAD']);
	} catch {
		mergeBranch(repo, branch);
	}
}

async function landTasks(
	api: DocumentApi,
	repo: string,
	taskIds: readonly string[],
): Promise<void> {
	await waitFor(
		'implement runs to leave the slot',
		async () => {
			const runs = await listRuns(api);
			return taskIds.every((taskId) =>
				runs.some(
					(run) =>
						run.taskId === taskId &&
						run.kind === 'implement' &&
						!['queued', 'starting', 'running'].includes(run.state),
				),
			);
		},
		60000,
	);
	await waitFor(
		'review to start',
		async () => {
			const runs = await listRuns(api);
			return taskIds.every((taskId) => runs.some((run) => run.taskId === taskId && run.kind === 'review'));
		},
		90000,
	);
	await waitFor(
		'review to finish',
		async () => {
			const runs = await listRuns(api);
			return taskIds.every((taskId) => {
				const reviews = runs.filter((run) => run.taskId === taskId && run.kind === 'review');
				return (
					reviews.length > 0 &&
					reviews.every((run) => !['queued', 'starting', 'running'].includes(run.state))
				);
			});
		},
		90000,
	);
	const implementRuns = (await listRuns(api)).filter(
		(run) => run.kind === 'implement' && taskIds.includes(run.taskId ?? ''),
	);
	for (const run of implementRuns) {
		if (run.worktreePath) rmSync(join(run.worktreePath, 'untracked-diff.txt'), { force: true });
		if (run.branchName) await mergeWhenReady(repo, run.branchName);
	}
}

async function finishBatch(
	api: DocumentApi,
	repo: string,
	taskIds: readonly string[],
	batchId: string,
): Promise<ListedRun> {
	const previous = new Set((await listRuns(api)).filter((run) => run.kind === 'wrapup').map((run) => run.id));
	await landTasks(api, repo, taskIds);
	const currentWrapup = async () => (await listRuns(api)).find((run) => run.kind === 'wrapup' && run.batchId === batchId && !previous.has(run.id));
	try {
		await waitFor(
			'wrapup run',
			async () => !!(await currentWrapup()),
			150000,
		);
	} catch (error) {
		const runs = await listRuns(api);
		const summary = runs
			.map((run) => `${run.kind}:${run.state}:${run.taskId ?? run.batchId ?? ''}`)
			.join(',');
		const message = error instanceof Error ? error.message : String(error);
		const worktrees = runs.filter((run) => run.worktreePath).map((run) => ({ id: run.id, state: run.state,
			status: git(run.worktreePath ?? repo, ['status', '--porcelain']),
			branch: run.branchName }));
		throw new Error(`${message} [${summary}] ${JSON.stringify(worktrees)}`);
	}
	await waitFor(
		'wrapup to finish',
		async () => {
			const run = await currentWrapup();
			return !!run && !['queued', 'starting', 'running'].includes(run.state);
		},
		90000,
	);
	const wrapup = await currentWrapup();
	if (!wrapup?.branchName) throw new Error('Current generation wrapup branch is missing');
	await mergeWhenReady(repo, wrapup.branchName);
	return wrapup;
}

describe('M1-T12 文档顺序自动执行', () => {
	it('imports three batches idle, then one start fills the window and relays (E-360, E-362, E-363, E-365, E-367, E-370)', async () => {
		const { daemon, api, page, browser } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-main-');
		const docsPath = commitDocs(
			repo.repo,
			'docs-data.js',
			readFileSync(join(fixturesDir, 'document-execution-docs-data.js'), 'utf8'),
		);
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		await setLaneCount(api, docId, 2);
		writeControl(daemon, {
			tasks: { 'DE-B1-A': 'hold', 'DE-B1-B': 'hold', 'DE-B1-C': 'hold' },
			review: 'pass',
			wrapup: 'clean',
		});
		await new Promise((resolveWait) => setTimeout(resolveWait, 11000));
		expect((await listRuns(api)).length).toBe(0);
		expect(await visibleText(page, '[data-testid="document-execution-state"]')).toBe('待开始');
		expect((await executionOf(api, docId)).state).toBe('idle');

		await chooseAgent(page, 'codex');
		await selectVendorEffort(page);
		await page.locator('[data-action="start-document"]').click();
		await waitFor('running plan', async () => (await executionOf(api, docId)).state === 'running');
		const started = await executionOf(api, docId);
		expect(started.defaultAssignment).toMatchObject({
			agentId: 'codex',
			effort: { vendor: 'ultra' },
		});
		expect(started.currentBatchNo).toBe(1);
		expect(await visibleText(page, '[data-testid="document-execution-state"]')).toBe('执行中');

		const tasks = await taskIndex(api, docId);
		const batch1 = (await batchesOf(api, docId)).find((batch) => batch.batchNo === 1);
		if (!batch1) throw new Error('Batch 1 is missing');
		await waitFor('two window slots', async () => {
			const running = (await listRuns(api)).filter(occupies);
			return running.length === 2;
		});
		const firstWave = (await listRuns(api)).filter((run) => run.kind === 'implement');
		expect(firstWave.filter(occupies)).toHaveLength(2);
		expect(firstWave.some((run) => run.taskId === tasks.get('DE-B1-C')?.id)).toBe(false);
		expect(await visibleText(page, '[data-testid="document-execution"]')).toContain('窗口占用 2 / 2');
		const versionAfterStart = started.version;
		const resources = readResources(daemon.dataDir, docId);
		for (const run of firstWave) {
			expect(run.attemptNo).toBe(1);
			const snapshot = readRunSnapshot(daemon.dataDir, run.id);
			expect(snapshot.assignment).toMatchObject({ effortVendor: 'ultra' });
		}

		const retry = await page.evaluate(
			async ({ port, token, docId: id, body }) => {
				const response = await fetch(`http://127.0.0.1:${port}/api/v1/documents/${id}/execution/start`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				return { status: response.status, body: await response.json() };
			},
			{
				port: daemon.port,
				token: api.token,
				docId,
				body: {
					expectedVersion: 0,
					expectedFingerprint: started.contentFingerprint,
					defaultAssignment: started.defaultAssignment,
				},
			},
		);
		expect(retry.status).toBe(200);
		expect((await executionOf(api, docId)).version).toBe(versionAfterStart);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement')).toHaveLength(2);
		expect(readResources(daemon.dataDir, docId)).toEqual(resources);

		releaseAgents(daemon, ['DE-B1-A']);
		await waitFor('backfill of the queued task', async () =>
			(await listRuns(api)).some(
				(run) => run.taskId === tasks.get('DE-B1-C')?.id && run.kind === 'implement',
			),
		);
		releaseAgents(daemon, ['all']);
		const ids = ['DE-B1-A', 'DE-B1-B', 'DE-B1-C'].map((key) => tasks.get(key)?.id ?? '');
		await waitFor('batch 1 implements to accept the release', async () => {
			const runs = await listRuns(api);
			return ids.every((taskId) =>
				runs.some((run) => run.taskId === taskId && run.kind === 'implement' && !occupies(run)),
			);
		});
		clearRelease(daemon);
		writeControl(daemon, { tasks: { 'DE-B2-A': 'hold' }, review: 'pass', wrapup: 'clean' });
		await finishBatch(api, repo.repo, ids, batch1.id);
		await waitFor(
			'batch 2 via the execution stream',
			async () => (await executionOf(api, docId)).currentBatchNo === 2,
			30000,
		);
		expect(await visibleText(page, '[data-testid="document-execution"]')).toContain('第 2 / 3 批');
		const batch2Run = await waitForRun(api, tasks.get('DE-B2-A')?.id ?? '', 'implement');
		expect(batch2Run.effortVendor ?? batch2Run.effort?.vendor).toBe('ultra');

		await page.locator('[data-action="pause-document"]').click();
		await waitFor('paused', async () => (await executionOf(api, docId)).state === 'paused');
		const pausedVersion = (await executionOf(api, docId)).version;
		releaseAgents(daemon, ['all']);
		await waitFor(
			'accepted run to finish during pause',
			async () => {
				const run = (await listRuns(api)).find((item) => item.id === batch2Run.id);
				return !!run && !occupies(run);
			},
			30000,
		);
		await new Promise((resolveWait) => setTimeout(resolveWait, 6000));
		expect(
			(await listRuns(api)).some((run) => run.taskId === tasks.get('DE-B2-A')?.id && run.kind === 'review'),
		).toBe(false);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-B3-A')?.id)).toBe(false);

		const second = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await pairPage(second, daemon, api.token);
		await page.locator('[data-action="resume-document"]').click();
		await waitFor('resumed', async () => (await executionOf(api, docId)).state === 'running');
		await second.locator('[data-testid="document-execution-document"]').selectOption(docId);
		await second.locator('[data-action="pause-document"]').click();
		await waitFor('paused again', async () => (await executionOf(api, docId)).state === 'paused');
		const staleResume = await page.evaluate(
			async ({ port, token, docId: id, expectedVersion, expectedFingerprint }) => {
				const response = await fetch(`http://127.0.0.1:${port}/api/v1/documents/${id}/execution/resume`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ expectedVersion, expectedFingerprint }),
				});
				return { status: response.status, body: await response.json() };
			},
			{
				port: daemon.port,
				token: api.token,
				docId,
				expectedVersion: pausedVersion,
				expectedFingerprint: (await executionOf(api, docId)).contentFingerprint,
			},
		);
		expect(staleResume.status).toBe(400);
		await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
		expect((await executionOf(api, docId)).state).toBe('paused');
		await second.close();

		await page.locator('[data-action="resume-document"]').click();
		await waitFor('review after resume', async () =>
			(await listRuns(api)).some((run) => run.taskId === tasks.get('DE-B2-A')?.id && run.kind === 'review'),
		);
		const batch2 = (await batchesOf(api, docId)).find((batch) => batch.batchNo === 2);
		if (!batch2) throw new Error('Batch 2 is missing');
		await finishBatch(api, repo.repo, [tasks.get('DE-B2-A')?.id ?? ''], batch2.id);
		await waitFor('batch 3', async () => (await executionOf(api, docId)).currentBatchNo === 3);
		const batch3 = (await batchesOf(api, docId)).find((batch) => batch.batchNo === 3);
		if (!batch3) throw new Error('Batch 3 is missing');
		await finishBatch(api, repo.repo, [tasks.get('DE-B3-A')?.id ?? ''], batch3.id);
		await waitFor('completed', async () => (await executionOf(api, docId)).state === 'completed', 30000);
		expect(await visibleText(page, '[data-testid="document-execution-state"]')).toBe('全部批次已完成');
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(
			join(artifactsDir, 'document-execution-main.json'),
			JSON.stringify({ docId, state: 'completed', effort: 'ultra' }, null, 2),
			'utf8',
		);
	}, 480000);

	it.each([false, true])('recovers the registered default Agent with paused=%s and keeps a drafted sibling moving (E-362, E-365)', async (pauseDuringOutage) => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-agent-');
		const docsPath = commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				{ id: 'DE-WAIT', hash: 'hash-wait', paths: ['src/wait.ts'] },
				{ id: 'DE-OTHER', hash: 'hash-other', paths: ['src/other.ts'] },
			]),
		);
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		const fingerprint = await sourceFingerprint(api, docId);
		const unknown = await api.post(`/api/v1/documents/${docId}/execution/start`, {
			expectedVersion: 0,
			expectedFingerprint: fingerprint,
			defaultAssignment: { agentId: 'missing-agent', modelName: null, effort: null },
		});
		expect(unknown.status).toBe(400);
		expect((unknown.body.error as { code?: string } | undefined)?.code).toBe('E_VALIDATION');
		const illegal = await api.post(`/api/v1/documents/${docId}/execution/start`, {
			expectedVersion: 0,
			expectedFingerprint: fingerprint,
			defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'not-a-real-effort' } },
		});
		expect(illegal.status).toBe(400);
		expect((await executionOf(api, docId)).state).toBe('idle');
		expect((await listRuns(api)).length).toBe(0);
		expect(readResources(daemon.dataDir, docId).executionCount).toBe(0);

		const agentsPath = join(daemon.dataDir, 'agents.json');
		const saved = readFileSync(agentsPath, 'utf8');
		const broken = JSON.parse(saved) as { overrides: { codex: { execPath: string } } };
		broken.overrides.codex.execPath = join(daemon.dataDir, 'missing-agent.exe');
		writeFileSync(agentsPath, JSON.stringify(broken), 'utf8');
		await waitFor('codex unavailable', async () => {
			await api.post('/api/v1/agents/codex/probe', {});
			const listed = await api.get('/api/v1/agents');
			const agents = listed.body.agents as Array<{ id: string; isAvailable: boolean }>;
			return agents.some((agent) => agent.id === 'codex' && agent.isAvailable === false);
		});
		const tasks = await taskIndex(api, docId);
		const batchId = tasks.get('DE-OTHER')?.batchId ?? '';
		const draft = await api.post(`/api/v1/batches/${batchId}/assignments`, {
			assignments: [{ taskId: tasks.get('DE-OTHER')?.id, agentId: 'claude', effort: null }],
		});
		expect(draft.status).toBe(200);
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		await waitFor('waiting plan', async () => {
			const execution = await executionOf(api, docId);
			const blockers = execution.blockers as Array<{ code: string }>;
			return execution.state === 'running' && blockers.some((blocker) => blocker.code === 'agent_unavailable');
		});
		expect(await visibleText(page, '[data-testid="agent-unavailable-wait"]')).toBeTruthy();
		await waitFor('drafted sibling', async () =>
			(await listRuns(api)).some((run) => run.taskId === tasks.get('DE-OTHER')?.id && run.agentId === 'claude'),
		);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-WAIT')?.id)).toBe(false);

		const waitingVersion = (await executionOf(api, docId)).version;
		if (pauseDuringOutage) {
			await page.locator('[data-action="pause-document"]').click();
			await waitFor('paused while waiting', async () => (await executionOf(api, docId)).state === 'paused');
		}
		writeFileSync(agentsPath, saved, 'utf8');
		await page.locator('[data-action="refresh-agent"]').click();
		await page.locator('[data-testid="probe-agent-btn-codex"]').click();
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		if (pauseDuringOutage) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 6000));
			expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-WAIT')?.id)).toBe(false);
			await page.locator('[data-action="resume-document"]').click();
		} else {
			expect((await executionOf(api, docId)).version).toBe(waitingVersion);
		}
		await waitFor('default agent resumes', async () =>
			(await listRuns(api)).some((run) => run.taskId === tasks.get('DE-WAIT')?.id && run.agentId === 'codex'),
		);
	}, 180000);

	it('isolates two document cursors while Agent slots and effective paths remain global (E-362)', async () => {
		const { daemon, api, page, browser } = await boot();
		await configureAutoPipeline(api);
		const registryPath = join(daemon.dataDir, 'agents.json');
		const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
		registry.overrides.codex.maxConcurrency = 1;
		writeFileSync(registryPath, JSON.stringify(registry));
		await api.post('/api/v1/agents/codex/probe', {});
		const repo = createRepo('agsched-doc-exec-shared-');
		const firstPath = commitDocs(repo.repo, 'one-docs-data.js', renderDocs([
			{ id: 'ONE-A', hash: 'one-a', paths: ['src/shared.ts'] },
			{ id: 'ONE-B', hash: 'one-b', paths: ['src/one.ts'] },
			{ id: 'ONE-NEXT', hash: 'one-next', deps: ['ONE-A', 'ONE-B'] },
		], 'First document'));
		const secondPath = commitDocs(repo.repo, 'two-docs-data.js', renderDocs([
			{ id: 'TWO-SHARED', hash: 'two-shared', paths: ['src/shared.ts'] },
			{ id: 'TWO-FREE', hash: 'two-free', paths: ['src/two.ts'] },
			{ id: 'TWO-NEXT', hash: 'two-next', deps: ['TWO-SHARED', 'TWO-FREE'] },
		], 'Second document'));
		writeControl(daemon, { implement: 'hold', review: 'pass', wrapup: 'clean' });
		await importThroughPage(page, firstPath, repo.repo);
		const firstId = await documentId(api);
		await setLaneCount(api, firstId, 2);
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const firstTasks = await taskIndex(api, firstId);
		await waitForRun(api, firstTasks.get('ONE-A')?.id ?? '', 'implement');
		const second = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await pairPage(second, daemon, api.token);
		await importThroughPage(second, secondPath, repo.repo);
		const documents = (await api.get('/api/v1/documents')).body.documents as Array<{ id: string; projectName: string }>;
		const secondId = documents.find((doc) => doc.projectName === 'Second document')?.id ?? '';
		expect(secondId).not.toBe(firstId);
		await setLaneCount(api, secondId, 2);
		await chooseAgent(second, 'claude');
		const pipeline = (await api.get('/api/v1/settings/pipeline')).body.pipeline as Record<string, unknown>;
		const stages = await api.patch('/api/v1/settings/pipeline', { ...pipeline,
			reviewOverride: { agentId: 'codex', modelName: 'doc-exec' },
			wrapupAssignment: { mode: 'fixed', agentId: 'codex', modelName: 'doc-exec' } });
		expect(stages.status, JSON.stringify(stages.body)).toBe(200);
		await second.locator('[data-action="start-document"]').click();
		const secondTasks = await taskIndex(api, secondId);
		await waitForRun(api, secondTasks.get('TWO-FREE')?.id ?? '', 'implement');
		await new Promise((resolveWait) => setTimeout(resolveWait, 5500));
		const held = (await listRuns(api)).filter(occupies);
		expect(held.filter((run) => run.agentId === 'codex')).toHaveLength(1);
		expect(held.some((run) => run.taskId === secondTasks.get('TWO-SHARED')?.id)).toBe(false);
		expect(held.some((run) => run.taskId === firstTasks.get('ONE-B')?.id)).toBe(false);
		expect((await executionOf(api, firstId)).currentBatchNo).toBe(1);
		expect((await executionOf(api, secondId)).currentBatchNo).toBe(1);
		await page.locator('[data-testid="document-execution-document"]').selectOption(firstId);
		await page.locator('[data-action="pause-document"]').click();
		const firstHolder = held.find((run) => run.taskId === firstTasks.get('ONE-A')?.id);
		expect(firstHolder).toBeDefined();
		await waitFor('path holder running before explicit stop', async () => (await listRuns(api)).some((run) => run.id === firstHolder?.id && run.state === 'running'));
		const stopped = await api.post(`/api/v1/runs/${firstHolder?.id}/abort`, {});
		expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
		await waitForRun(api, secondTasks.get('TWO-SHARED')?.id ?? '', 'implement');
		expect((await executionOf(api, firstId)).state).toBe('paused');
		expect((await executionOf(api, secondId)).state).toBe('running');
		expect((await listRuns(api)).some((run) => run.taskId === firstTasks.get('ONE-B')?.id)).toBe(false);
		expect((await listRuns(api)).some((run) => run.taskId === secondTasks.get('TWO-NEXT')?.id)).toBe(false);
		releaseAgents(daemon, ['TWO-FREE', 'TWO-SHARED']);
		const secondBatch = (await batchesOf(api, secondId)).find((batch) => batch.batchNo === 1);
		if (!secondBatch) throw new Error('Second document batch missing');
		await finishBatch(api, repo.repo, [secondTasks.get('TWO-FREE')?.id ?? '', secondTasks.get('TWO-SHARED')?.id ?? ''], secondBatch.id);
		await waitFor('second cursor advances independently', async () => (await executionOf(api, secondId)).currentBatchNo === 2, 60000);
		expect((await executionOf(api, firstId)).currentBatchNo).toBe(1);
		expect((await executionOf(api, firstId)).state).toBe('paused');
		const next = await waitForRun(api, secondTasks.get('TWO-NEXT')?.id ?? '', 'implement');
		expect(next.agentId).toBe('claude');
		await second.close();
	}, 420000);

	it('loses a real continue response, then rejects a stale retry after another device pauses (E-361)', async () => {
		const { daemon, api, page, browser, browserToken } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-lost-');
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'LOST', hash: 'lost' }]));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		const registryPath = join(daemon.dataDir, 'agents.json');
		const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
		registry.overrides.codex.execPath = join(daemon.dataDir, 'unavailable.exe');
		writeFileSync(registryPath, JSON.stringify(registry));
		await waitFor('unavailable registry entry', async () => {
			await api.post('/api/v1/agents/codex/probe', {});
			const agents = (await api.get('/api/v1/agents')).body.agents as Array<{ id: string; isAvailable: boolean }>;
			return agents.some((agent) => agent.id === 'codex' && !agent.isAvailable);
		});
		const second = await browser.newPage();
		const secondToken = await pairPage(second, daemon, api.token);
		expect(browserToken !== secondToken).toBe(true);
		const first = await executionOf(api, docId);
		const body = { expectedVersion: first.version, expectedFingerprint: await sourceFingerprint(api, docId),
			defaultAssignment: { agentId: 'codex', modelName: null, effort: null } };
		const requests = await Promise.all([{ page, token: browserToken }, { page: second, token: secondToken }].map((client) => client.page.evaluate(async ({ port, token, id, body: payload }) => {
			const response = await fetch(`http://127.0.0.1:${port}/api/v1/documents/${id}/execution/start`, {
				method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
			return response.status;
		}, { port: daemon.port, token: client.token, id: docId, body })));
		expect(requests).toEqual([200, 200]);
		const started = await executionOf(api, docId);
		expect(started.version).toBe(1);
		const before = readResources(daemon.dataDir, docId);
		expect((await api.post(`/api/v1/documents/${docId}/execution/start`, body)).status).toBe(200);
		expect(readResources(daemon.dataDir, docId)).toEqual(before);
		await page.locator('[data-action="pause-document"]').click();
		await waitFor('first pause', async () => (await executionOf(api, docId)).state === 'paused');
		const paused = await executionOf(api, docId);
		const resumeBody = { expectedVersion: paused.version, expectedFingerprint: paused.contentFingerprint };
		const discard = await requestWithoutResponse(daemon, apiFor(daemon, browserToken), `/api/v1/documents/${docId}/execution/resume`, resumeBody);
		await waitFor('commit observed without receiving the response', async () => (await executionOf(api, docId)).state === 'running');
		discard();
		await second.locator('[data-action="pause-document"]').click();
		await waitFor('second-device pause', async () => (await executionOf(api, docId)).state === 'paused');
		const latest = await executionOf(api, docId);
		const stale = await api.post(`/api/v1/documents/${docId}/execution/resume`, resumeBody);
		expect(stale.status).toBe(400);
		expect((await executionOf(api, docId)).version).toBe(latest.version);
		await new Promise((resolveWait) => setTimeout(resolveWait, 5500));
		expect((await executionOf(api, docId)).state).toBe('paused');
		expect(await listRuns(api)).toHaveLength(0);
		expect(readResources(daemon.dataDir, docId)).toEqual(before);
		writeFileSync(join(artifactsDir, 'lost-response.json'), JSON.stringify({ responseConsumed: false, disconnected: true, versions: [paused.version, latest.version], staleStatus: stale.status, runs: 0 }, null, 2));
		await second.close();
	}, 180000);

	it('does not cross a batch on an open, manual, or unmerged wrapup (E-363, E-364)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-gate-');
		const docsPath = commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				{ id: 'DE-GATE', hash: 'hash-gate' },
				{ id: 'DE-NEXT', hash: 'hash-next', deps: ['DE-GATE'] },
			]),
		);
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { review: 'pass', wrapup: 'open' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const first = (await batchesOf(api, docId)).find((batch) => batch.batchNo === 1);
		if (!first) throw new Error('Batch 1 is missing');
		await waitFor(
			'gate review to finish',
			async () =>
				(await listRuns(api)).some(
					(run) =>
						run.taskId === tasks.get('DE-GATE')?.id &&
						run.kind === 'review' &&
						!['queued', 'starting', 'running'].includes(run.state),
				),
			45000,
		);
		const implement = (await listRuns(api)).find(
			(run) => run.taskId === tasks.get('DE-GATE')?.id && run.kind === 'implement',
		);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-NEXT')?.id)).toBe(false);
		if (!implement?.branchName) throw new Error('Implement branch is missing');
		if (implement.worktreePath) {
			rmSync(join(implement.worktreePath, 'untracked-diff.txt'), { force: true });
		}
		await mergeWhenReady(repo.repo, implement.branchName);
		const openDeadline = Date.now() + 45000;
		let openObserved = '';
		while (Date.now() < openDeadline) {
			if (implement?.branchName) {
				try {
					git(repo.repo, ['merge-base', '--is-ancestor', implement.branchName, 'HEAD']);
				} catch {
					try {
						mergeBranch(repo.repo, implement.branchName);
					} catch {
						// The branch is checked out in the task worktree; the next tick retries.
					}
				}
			}
			const batches = await batchesOf(api, docId);
			const execution = await executionOf(api, docId);
			const runs = (await listRuns(api)).map((run) => ({
				kind: run.kind,
				state: run.state,
				taskId: run.taskId,
			}));
			openObserved = JSON.stringify({ batches, execution, runs });
			const batchState = batches.find((batch) => batch.id === first.id)?.state;
			if (batchState === 'needs_attention' || batchState === 'done') break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
		}
		if ((await batchesOf(api, docId)).find((batch) => batch.id === first.id)?.state !== 'needs_attention') {
			const branch = implement?.branchName ?? '';
			let ahead = '';
			try {
				ahead = git(repo.repo, ['rev-list', '--count', `main..${branch}`]).trim();
			} catch (error) {
				ahead = String(error);
			}
			throw new Error(`${openObserved}\nbranch=${branch} ahead=${ahead}`);
		}
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-NEXT')?.id)).toBe(false);
		expect(await visibleText(page, '[data-blocker="wrapup_attention"]')).toBeTruthy();
		expect(await visibleText(page, '[data-blocker-action="wrapup_attention"]')).toBeTruthy();
	}, 180000);

	it('waits for a real manual wrapup before relaying the next batch (E-364)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const pipeline = (await api.get('/api/v1/settings/pipeline')).body.pipeline as Record<string, unknown>;
		expect((await api.patch('/api/v1/settings/pipeline', { ...pipeline, wrapupMode: 'manual' })).status).toBe(200);
		const repo = createRepo('agsched-doc-exec-manual-');
		const path = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'MANUAL', hash: 'manual' }, { id: 'MANUAL-NEXT', hash: 'manual-next', deps: ['MANUAL'] }]));
		await importThroughPage(page, path, repo.repo);
		const docId = await documentId(api);
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const batch = (await batchesOf(api, docId))[0];
		if (!batch) throw new Error('Manual batch missing');
		await landTasks(api, repo.repo, [tasks.get('MANUAL')?.id ?? '']);
		await waitFor('manual wrapup blocker', async () => ((await executionOf(api, docId)).blockers as Array<{ code: string }>).some((blocker) => blocker.code === 'wrapup_manual'), 60000);
		expect((await listRuns(api)).filter((run) => run.kind === 'wrapup')).toHaveLength(0);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('MANUAL-NEXT')?.id)).toBe(false);
		expect(await visibleText(page, '[data-blocker="wrapup_manual"]')).toBeTruthy();
		const manual = await api.post(`/api/v1/batches/${batch.id}/wrapup`, { idempotencyKey: 'manual-document-wrapup' });
		expect(manual.status, JSON.stringify(manual.body)).toBe(200);
		await waitFor('manual clean report finishes', async () => (await listRuns(api)).some((run) =>
			run.kind === 'wrapup' && run.batchId === batch.id && run.state === 'landed'), 90000);
		const manualRuns = (await listRuns(api)).filter((run) => run.kind === 'wrapup' && run.batchId === batch.id);
		expect(manualRuns).toHaveLength(1);
		expect((await executionOf(api, docId)).currentBatchNo).toBe(1);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('MANUAL-NEXT')?.id)).toBe(false);
		const branch = manualRuns[0]?.branchName;
		if (!branch) throw new Error('Manual wrapup branch missing');
		await mergeWhenReady(repo.repo, branch);
		await waitFor('manual clean report relays', async () => (await executionOf(api, docId)).currentBatchNo === 2, 60000);
		await waitForRun(api, tasks.get('MANUAL-NEXT')?.id ?? '', 'implement');
	}, 240000);

	it.each(['dispatch', 'review', 'landing'] as const)('keeps the next batch blocked by the real %s human gate (E-364)', async (kind) => {
		const { api, page } = await boot();
		await configureAutoPipeline(api);
		expect((await api.patch('/api/v1/settings/gates', { dispatch: 'auto', review: 'auto', landing: 'auto', [kind]: 'manual' })).status).toBe(200);
		const repo = createRepo('agsched-doc-exec-human-');
		const path = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'HUMAN', hash: 'human' }, { id: 'HUMAN-NEXT', hash: 'human-next', deps: ['HUMAN'] }]));
		await importThroughPage(page, path, repo.repo);
		const docId = await documentId(api);
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		await waitFor(`${kind} human gate`, async () => {
			const gates = (await api.get('/api/v1/gates?pending=true')).body.gates as Array<{ kind: string; taskId: string }>;
			return gates.some((gate) => gate.kind === kind && gate.taskId === tasks.get('HUMAN')?.id);
		}, 60000);
		await new Promise((resolveWait) => setTimeout(resolveWait, 5500));
		expect((await executionOf(api, docId)).currentBatchNo).toBe(1);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('HUMAN-NEXT')?.id)).toBe(false);
		expect((await listRuns(api)).some((run) => run.kind === 'wrapup')).toBe(false);
		expect(await visibleText(page, '[data-blocker="gate_waiting"]')).toBeTruthy();
	}, 180000);

	it('pauses an unreadable source, preserves the accepted snapshot, and resumes only after source confirmation (E-369)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-unreadable-');
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'SOURCE', hash: 'source' }, { id: 'SOURCE-NEXT', hash: 'source-next', deps: ['SOURCE'] }]));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { implement: 'hold' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const accepted = await waitForRun(api, tasks.get('SOURCE')?.id ?? '', 'implement');
		const frozen = readRunSnapshot(daemon.dataDir, accepted.id);
		renameSync(docsPath, `${docsPath}.saved`);
		try {
			await api.post(`/api/v1/documents/${docId}/refresh`, {});
			await waitFor('source unreadable pause', async () => (await executionOf(api, docId)).pauseReason === 'source_unreadable');
			expect((await executionOf(api, docId)).state).toBe('paused');
			expect(await visibleText(page, '[data-testid="document-execution-state"]')).toContain('源');
			releaseAgents(daemon, ['SOURCE']);
			await waitFor('accepted implementation exits during source pause', async () => (await listRuns(api)).some((run) => run.id === accepted.id && run.state === 'exited'));
			expect(readRunSnapshot(daemon.dataDir, accepted.id)).toEqual(frozen);
			expect((await listRuns(api)).filter((run) => run.kind === 'review')).toHaveLength(0);
		} finally { renameSync(`${docsPath}.saved`, docsPath); }
		await page.locator('[data-action="confirm-document-source"]').click();
		await page.locator('[data-action="resume-document"]').click();
		await waitForRun(api, tasks.get('SOURCE')?.id ?? '', 'review');
		expect((await listRuns(api)).filter((run) => run.kind === 'implement')).toHaveLength(1);
	}, 180000);

	it.each(['contract', 'move', 'delete'] as const)('isolates accepted snapshots and old reviews after a real %s refresh (E-369)', async (change) => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-source-change-');
		const initial = [{ id: 'CHANGE-A', hash: 'change-a' }, { id: 'CHANGE-B', hash: 'change-b' }, { id: 'CHANGE-NEXT', hash: 'change-next', deps: ['CHANGE-A', 'CHANGE-B'] }];
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs(initial));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		await setLaneCount(api, docId, 2);
		writeControl(daemon, { implement: 'hold' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const old = await waitForRun(api, tasks.get('CHANGE-B')?.id ?? '', 'implement');
		await waitFor('old source implementation running', async () => (await listRuns(api)).some((run) => run.id === old.id && run.state === 'running'));
		const frozen = readRunSnapshot(daemon.dataDir, old.id);
		const oldRunIds = new Set((await listRuns(api)).filter((run) => run.kind === 'implement').map((run) => run.id));
		const before = readPlan(daemon.dataDir, docId)[0];
		const next = change === 'contract' ? initial.map((task) => task.id === 'CHANGE-B' ? { ...task, hash: 'changed-b' } : task)
			: change === 'move' ? initial.map((task) => task.id === 'CHANGE-B' ? { ...task, deps: ['CHANGE-A'] } : task)
			: initial.filter((task) => task.id !== 'CHANGE-B').map((task) => task.id === 'CHANGE-NEXT' ? { ...task, deps: ['CHANGE-A'] } : task);
		commitDocs(repo.repo, 'docs-data.js', renderDocs(next));
		expect((await api.post(`/api/v1/documents/${docId}/refresh`, {})).status).toBe(200);
		await waitFor('changed source pause', async () => (await executionOf(api, docId)).state === 'paused');
		expect(readRunSnapshot(daemon.dataDir, old.id)).toEqual(frozen);
		await page.locator('[data-action="confirm-document-source"]').click();
		await page.locator('[data-action="resume-document"]').click();
		await waitFor('old source wait', async () => ((await executionOf(api, docId)).blockers as Array<{ code: string }>).some((blocker) => blocker.code === 'source_runs_pending'));
		const current = readPlan(daemon.dataDir, docId)[0];
		expect(current?.generationId).toBeGreaterThan(Number(before?.generationId));
		expect(current?.completion).toBeNull();
		expect(current?.membershipFingerprint).not.toBe(before?.membershipFingerprint);
		releaseAgents(daemon, ['CHANGE-A', 'CHANGE-B']);
		await waitFor('old source results recorded', async () => (await listRuns(api)).some((run) => run.id === old.id && (run.state === 'exited' || (run.state === 'failed' && run.queuedReason === 'source_changed'))));
		clearRelease(daemon);
		await new Promise((resolveWait) => setTimeout(resolveWait, 5500));
		expect((await listRuns(api)).filter((run) => run.kind === 'review' && run.parentRunId === old.id)).toHaveLength(0);
		expect((await executionOf(api, docId)).state).not.toBe('completed');
		const members = (readPlan(daemon.dataDir, docId)[0]?.members ?? []) as Array<{ taskId: string; contractHash: string }>;
		await waitFor('current-generation members dispatch from their frozen contracts', async () => {
			const runs = await listRuns(api);
			return members.every((member) => runs.some((run) => {
				if (run.kind !== 'implement' || run.taskId !== member.taskId || oldRunIds.has(run.id)) return false;
				const snapshot = readRunSnapshot(daemon.dataDir, run.id);
				return snapshot.contract_hash === member.contractHash && (snapshot.launch as { documentGenerationId?: number }).documentGenerationId === current?.generationId;
			}));
		}, 60000);
		if (change !== 'contract') expect(members.some((member) => member.taskId === old.taskId)).toBe(false);
		else expect(members.find((member) => member.taskId === old.taskId)?.contractHash).toBe('changed-b');
	}, 240000);

	it('refreshes readiness without pausing a ready sibling or changing its generation/snapshot (E-369)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-readiness-');
		const specs = [{ id: 'READY', hash: 'ready' }, { id: 'WAIT-READY', hash: 'wait-ready', ready: false, reasons: ['review pending'] }];
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs(specs));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { implement: 'hold' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const accepted = await waitForRun(api, tasks.get('READY')?.id ?? '', 'implement');
		const snapshot = readRunSnapshot(daemon.dataDir, accepted.id);
		const plan = readPlan(daemon.dataDir, docId);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('WAIT-READY')?.id)).toBe(false);
		commitDocs(repo.repo, 'docs-data.js', renderDocs(specs.map((spec) => ({ ...spec, ready: true, reasons: [] }))));
		expect((await api.post(`/api/v1/documents/${docId}/refresh`, {})).status).toBe(200);
		await waitForRun(api, tasks.get('WAIT-READY')?.id ?? '', 'implement');
		expect((await executionOf(api, docId)).state).toBe('running');
		expect(readPlan(daemon.dataDir, docId)).toEqual(plan);
		expect(readRunSnapshot(daemon.dataDir, accepted.id)).toEqual(snapshot);
	}, 180000);

	it('restarts paused, backfills one undispatched task, and preserves failed/interrupted/orphaned/aborted exactly (E-368)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const registryPath = join(daemon.dataDir, 'agents.json');
		const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
		registry.overrides.codex.maxConcurrency = 4;
		writeFileSync(registryPath, JSON.stringify(registry));
		await api.post('/api/v1/agents/codex/probe', {});
		const repo = createRepo('agsched-doc-exec-restart-');
		const specs = ['DE-A-FAIL', 'DE-B-ABORT', 'DE-C-INTERRUPT', 'DE-D-ORPHAN', 'DE-E-UNSENT'].map((id) => ({ id, hash: id, ready: id !== 'DE-E-UNSENT' }));
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs(specs));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		await setLaneCount(api, docId, 4);
		writeControl(daemon, { implement: 'hold', review: 'pass', wrapup: 'clean' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		await waitFor('four admitted implementations', async () => (await listRuns(api)).filter((run) => run.kind === 'implement' && run.state === 'running').length === 4);
		writeControl(daemon, { tasks: { 'DE-A-FAIL': 'empty' }, implement: 'hold', review: 'pass' });
		releaseAgents(daemon, ['DE-A-FAIL']);
		let gateId = '';
		await waitFor('mechanical failure gate', async () => {
			const gates = (await api.get('/api/v1/gates?pending=true')).body.gates as Array<{ id: string; taskId: string }>;
			gateId = gates.find((gate) => gate.taskId === tasks.get('DE-A-FAIL')?.id)?.id ?? '';
			return !!gateId;
		});
		expect((await api.post(`/api/v1/gates/${gateId}/decide`, { decision: 'reject' })).status).toBe(200);
		await waitFor('exact failed state', async () => (await listRuns(api)).some((run) => run.taskId === tasks.get('DE-A-FAIL')?.id && run.state === 'failed'));
		const abortTarget = await waitForRun(api, tasks.get('DE-B-ABORT')?.id ?? '', 'implement');
		await waitFor('abort target running', async () => (await listRuns(api)).some((run) => run.id === abortTarget.id && run.state === 'running'));
		const abort = await api.post(`/api/v1/runs/${abortTarget.id}/abort`, {});
		expect(abort.status, JSON.stringify(abort.body)).toBe(200);
		expect((await listRuns(api)).find((run) => run.id === abortTarget.id)?.state).toBe('aborted');
		const interrupted = await waitForRun(api, tasks.get('DE-C-INTERRUPT')?.id ?? '', 'implement');
		const orphaned = await waitForRun(api, tasks.get('DE-D-ORPHAN')?.id ?? '', 'implement');
		expect(interrupted.pid).toBeGreaterThan(0);
		expect(orphaned.pid).toBeGreaterThan(0);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-E-UNSENT')?.id)).toBe(false);
		const dataDir = daemon.dataDir;
		const port = daemon.port;
		await daemon.stop({ keepData: true });
		// Only the owned child dies while the daemon is down; the other remains live for orphan reconciliation.
		process.kill(interrupted.pid ?? 0, 'SIGKILL');
		process.kill(orphaned.pid ?? 0, 0);
		commitDocs(repo.repo, 'docs-data.js', renderDocs(specs.map((spec) => ({ ...spec, ready: true }))));
		const restarted = await restartDaemon(dataDir, port);
		active.daemon = restarted;
		const next = apiFor(restarted, api.token);
		await page.goto(`http://127.0.0.1:${port}/#/`, { waitUntil: 'domcontentloaded' });
		await waitFor('durable restart pause', async () => {
			const execution = await executionOf(next, docId);
			return execution.state === 'paused' && execution.pauseReason === 'daemon_restarted';
		});
		await waitFor('restart reason on page', async () => {
			const retry = page.locator('[data-testid="retry-snapshot"]');
			if (await retry.isVisible().catch(() => false)) await retry.click();
			return (await page.locator('[data-testid="document-execution-state"]').innerText().catch(() => '')).includes('调度服务重启后已暂停');
		});
		const expected = new Map([[tasks.get('DE-A-FAIL')?.id, 'failed'], [tasks.get('DE-B-ABORT')?.id, 'aborted'], [tasks.get('DE-C-INTERRUPT')?.id, 'interrupted'], [tasks.get('DE-D-ORPHAN')?.id, 'orphaned']]);
		await waitFor('exact restart classifications', async () => {
			const runs = await listRuns(next);
			return [...expected].every(([taskId, state]) => runs.some((run) => run.taskId === taskId && run.state === state));
		});
		expect((await listRuns(next)).filter((run) => run.kind === 'implement')).toHaveLength(4);
		await page.locator('[data-action="confirm-document-source"]').click();
		await page.locator('[data-action="resume-document"]').click();
		await waitForRun(next, tasks.get('DE-E-UNSENT')?.id ?? '', 'implement');
		await new Promise((resolveWait) => setTimeout(resolveWait, 5500));
		const after = await listRuns(next);
		expect(after.filter((run) => run.kind === 'implement')).toHaveLength(5);
		for (const [taskId, state] of expected) {
			const implementsForTask = after.filter((run) => run.taskId === taskId && run.kind === 'implement');
			expect(implementsForTask).toHaveLength(1);
			expect(implementsForTask[0]?.state).toBe(state);
		}
		writeFileSync(join(artifactsDir, 'restart-states.json'), JSON.stringify(after.filter((run) => run.kind === 'implement'), null, 2));
		releaseAgents(restarted, ['all']);
	}, 300000);

	it('pauses on a contract change, keeps a completed task, and runs only the new member (E-369)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-member-');
		const original = [
			{ id: 'DE-OLD', hash: 'hash-old' },
			{ id: 'DE-DONE', hash: 'hash-done', deps: ['DE-OLD'] },
		];
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs(original));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { review: 'pass', wrapup: 'clean' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const first = (await batchesOf(api, docId)).find((batch) => batch.batchNo === 1);
		const second = (await batchesOf(api, docId)).find((batch) => batch.batchNo === 2);
		if (!first || !second) throw new Error('Two batches are required');
		await finishBatch(api, repo.repo, [tasks.get('DE-OLD')?.id ?? ''], first.id);
		await waitFor('second batch', async () => (await executionOf(api, docId)).currentBatchNo === 2);
		await finishBatch(api, repo.repo, [tasks.get('DE-DONE')?.id ?? ''], second.id);
		await waitFor('member doc completed', async () => (await executionOf(api, docId)).state === 'completed');
		const oldRuns = (await listRuns(api)).filter((run) => run.kind === 'implement').length;

		commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				...original,
				{ id: 'DE-NEW', hash: 'hash-new', deps: ['DE-OLD'] },
			]),
		);
		await page.locator('[data-testid="import-doc-path"]').fill(docsPath);
		await page.locator('[data-testid="import-repo-path"]').fill(repo.repo);
		await page.locator('[data-action="rebind-document"]').click();
		await page.locator('[data-action="confirm-document-source"]').click();
		await waitFor('reopened idle', async () => (await executionOf(api, docId)).state === 'idle');
		expect(await visibleText(page, '[data-testid="document-execution-state"]')).toBe('待开始');
		const plan = readPlan(daemon.dataDir, docId);
		const changed = plan.find((entry) =>
			(entry.members as Array<{ taskKey: string }> | undefined)?.some((member) => member.taskKey === 'DE-NEW'),
		);
		expect(changed?.completion ?? null).toBeNull();
		const refreshedTasks = await taskIndex(api, docId);
		const newTaskId = refreshedTasks.get('DE-NEW')?.id;
		expect(newTaskId).toBeTruthy();
		await page.locator('[data-action="start-document"]').click();
		await waitFor('new member run', async () =>
			(await listRuns(api)).some((run) => run.kind === 'implement' && run.taskId === newTaskId),
		);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement' && run.taskId === tasks.get('DE-OLD')?.id)).toHaveLength(1);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement').length).toBe(oldRuns + 1);
		expect((await executionOf(api, docId)).state).not.toBe('completed');
		const newWrapup = await finishBatch(api, repo.repo, [tasks.get('DE-DONE')?.id ?? '', newTaskId ?? ''], second.id);
		await waitFor('new membership really completes', async () => (await executionOf(api, docId)).state === 'completed');
		const completed = readPlan(daemon.dataDir, docId).find((entry) => entry.batchId === second.id);
		expect(completed?.completion).toMatchObject({ completionFingerprint: completed?.membershipFingerprint });
		expect(readSnapshotInput(daemon.dataDir, newWrapup.id)?.membershipFingerprint).toBe(completed?.membershipFingerprint);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement' && run.taskId === tasks.get('DE-DONE')?.id)).toHaveLength(1);
		const dto = await api.get(`/api/v1/batches/${second.id}/wrapups`);
		const dtos = dto.body.wrapups as Array<{ runId: string; tasks: string[] }>;
		expect(dtos.find((row) => row.runId === newWrapup.id)?.tasks).toEqual(['DE-DONE', 'DE-NEW']);
		const rows = readWrapupRows(daemon.dataDir, second.id);
		for (const row of rows) {
			const parsed = JSON.parse(String(row.tasks_json)) as unknown;
			expect(Array.isArray(parsed)).toBe(true);
			expect((parsed as unknown[]).every((item) => typeof item === 'string')).toBe(true);
			expect(parsed).toEqual([...(parsed as string[])].sort());
		}
	}, 360000);

	it('keeps the six-attempt ceiling on the old generation and allows the next generation once (E-369)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-gen-');
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'DE-GEN', hash: 'hash-gen' }]));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { review: 'pass', wrapup: 'fail' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const batch = (await batchesOf(api, docId))[0];
		if (!batch) throw new Error('Batch is missing');
		await waitFor(
			'generation implement',
			async () =>
				(await listRuns(api)).some(
					(run) => run.taskId === tasks.get('DE-GEN')?.id && run.kind === 'implement' && !occupies(run),
				),
			45000,
		);
		await waitFor(
			'generation review to finish',
			async () =>
				(await listRuns(api)).some(
					(run) =>
						run.taskId === tasks.get('DE-GEN')?.id &&
						run.kind === 'review' &&
						!['queued', 'starting', 'running'].includes(run.state),
				),
			45000,
		);
		const implement = (await listRuns(api)).find(
			(run) => run.taskId === tasks.get('DE-GEN')?.id && run.kind === 'implement',
		);
		if (!implement?.branchName) throw new Error('Generation branch is missing');
		if (implement.worktreePath) rmSync(join(implement.worktreePath, 'untracked-diff.txt'), { force: true });
		await mergeWhenReady(repo.repo, implement.branchName);
		await waitFor(
			'first failed wrapup',
			async () => ((await executionOf(api, docId)).wrapupProgress as { physicalAttempts?: number } | null)?.physicalAttempts === 1,
			30000,
		);
		for (let attempt = 2; attempt <= 5; attempt += 1) {
			await page.reload({ waitUntil: 'domcontentloaded' });
			await page.locator('[data-blocker-action="wrapup_attention"]').click();
			await waitFor(
				`physical attempt ${attempt}`,
				async () =>
					((await executionOf(api, docId)).wrapupProgress as { physicalAttempts?: number } | null)
						?.physicalAttempts === attempt,
				30000,
			);
		}
		const fifth = (await executionOf(api, docId)).wrapupProgress as {
			generationId: number;
			validRounds: number;
			physicalAttempts: number;
		};
		expect(fifth).toMatchObject({ validRounds: 0, physicalAttempts: 5 });
		const generationId = fifth.generationId;
		writeControl(daemon, { review: 'pass', wrapup: 'clean' });
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.locator('[data-blocker-action="wrapup_attention"]').click();
		await waitFor('sixth wrapup completes the batch', async () => {
			const state = (await batchesOf(api, docId))[0]?.state;
			return state === 'done';
		}, 30000);
		const wrapup = (await listRuns(api))
			.filter((run) => run.kind === 'wrapup' && run.batchId === batch.id)
			.sort((a, b) => b.attemptNo - a.attemptNo)[0];
		expect(wrapup?.attemptNo).toBe(6);
		if (wrapup?.branchName) await mergeWhenReady(repo.repo, wrapup.branchName);
		await waitFor('generation document completed', async () => (await executionOf(api, docId)).state === 'completed');
		const frozen = wrapup ? readSnapshotInput(daemon.dataDir, wrapup.id) : null;
		expect(frozen?.membershipFingerprint).toEqual(expect.any(String));
		expect(JSON.stringify(frozen)).not.toContain('"tasks":');
		const oldEntry = readPlan(daemon.dataDir, docId)[0];
		expect(oldEntry?.wrapupRunIds).toHaveLength(6);

		commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				{ id: 'DE-GEN', hash: 'hash-gen' },
				{ id: 'DE-GEN-2', hash: 'hash-gen-2' },
			]),
		);
		await page.locator('[data-testid="import-doc-path"]').fill(docsPath);
		await page.locator('[data-testid="import-repo-path"]').fill(repo.repo);
		await page.locator('[data-action="rebind-document"]').click();
		await page.locator('[data-action="confirm-document-source"]').click();
		await waitFor('new generation idle', async () => (await executionOf(api, docId)).state === 'idle');
		const currentTasks = await taskIndex(api, docId);
		const newId = currentTasks.get('DE-GEN-2')?.id ?? '';
		expect(newId).toBeTruthy();
		await page.locator('[data-action="start-document"]').click();
		const newRun = await waitForRun(api, newId, 'implement');
		expect(readRunSnapshot(daemon.dataDir, newRun.id).contract_hash).toBe('hash-gen-2');
		const newEntry = readPlan(daemon.dataDir, docId)[0];
		expect(newEntry?.generationId).toBeGreaterThan(generationId);
		expect(newEntry?.wrapupRunIds).toEqual([]);
		const currentWrapup = await finishBatch(api, repo.repo, [tasks.get('DE-GEN')?.id ?? '', newId], batch.id);
		await waitFor('new generation completes its first wrapup', async () => (await executionOf(api, docId)).state === 'completed');
		const complete = readPlan(daemon.dataDir, docId)[0];
		expect(complete?.wrapupRunIds).toEqual([currentWrapup.id]);
		expect(complete?.completion).toMatchObject({ completionFingerprint: complete?.membershipFingerprint });
		expect(readSnapshotInput(daemon.dataDir, currentWrapup.id)).toMatchObject({ generationId: complete?.generationId, membershipFingerprint: complete?.membershipFingerprint });
		expect((await listRuns(api)).filter((run) => run.kind === 'implement' && run.taskId === tasks.get('DE-GEN')?.id)).toHaveLength(1);
	}, 480000);

	it('invalidates wrapping membership, waits for the old source, and ignores its late clean callback (E-369)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-wrapping-');
		const original = [{ id: 'WRAP-OLD', hash: 'wrap-old' }, { id: 'WRAP-NEXT', hash: 'wrap-next', deps: ['WRAP-OLD'] }];
		const docsPath = commitDocs(repo.repo, 'docs-data.js', renderDocs(original));
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { review: 'pass', wrapup: 'hold' });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const batch = (await batchesOf(api, docId))[0];
		if (!batch) throw new Error('Wrapping batch missing');
		await landTasks(api, repo.repo, [tasks.get('WRAP-OLD')?.id ?? '']);
		let oldWrapup: ListedRun | undefined;
		await waitFor('old generation wrapping', async () => {
			oldWrapup = (await listRuns(api)).find((run) => run.kind === 'wrapup' && run.state === 'running');
			return !!oldWrapup;
		}, 60000);
		if (!oldWrapup) throw new Error('Old wrapup missing');
		const oldFrozen = readSnapshotInput(daemon.dataDir, oldWrapup.id);
		const oldPlan = readPlan(daemon.dataDir, docId)[0];
		commitDocs(repo.repo, 'docs-data.js', renderDocs([...original, { id: 'WRAP-NEW', hash: 'wrap-new' }]));
		expect((await api.post(`/api/v1/documents/${docId}/refresh`, {})).status).toBe(200);
		await waitFor('wrapping change pause', async () => (await executionOf(api, docId)).state === 'paused');
		await page.locator('[data-action="confirm-document-source"]').click();
		await page.locator('[data-action="resume-document"]').click();
		await waitFor('source_runs_pending during wrapping reset', async () => ((await executionOf(api, docId)).blockers as Array<{ code: string }>).some((blocker) => blocker.code === 'source_runs_pending'));
		expect((await batchesOf(api, docId)).find((item) => item.id === batch.id)?.state).toBe('idle');
		const replacement = readPlan(daemon.dataDir, docId)[0];
		expect(replacement?.generationId).toBeGreaterThan(Number(oldPlan?.generationId));
		expect(replacement?.membershipFingerprint).not.toBe(oldPlan?.membershipFingerprint);
		expect(replacement?.wrapupRunIds).toEqual([]);
		expect(replacement?.completion).toBeNull();
		const newTasks = await taskIndex(api, docId);
		const newId = newTasks.get('WRAP-NEW')?.id ?? '';
		writeControl(daemon, { tasks: { 'WRAP-NEW': 'hold' }, review: 'pass', wrapup: 'clean' });
		releaseAgents(daemon, ['wrapup']);
		await waitFor('late old callback retained', async () => readWrapupRows(daemon.dataDir, batch.id).some((row) => row.run_id === oldWrapup?.id));
		expect(readSnapshotInput(daemon.dataDir, oldWrapup.id)).toEqual(oldFrozen);
		const newRun = await waitForRun(api, newId, 'implement');
		expect(newRun.taskId).toBe(newId);
		expect((await batchesOf(api, docId)).find((item) => item.id === batch.id)?.state).not.toBe('done');
		expect((await executionOf(api, docId)).currentBatchNo).toBe(1);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement' && run.taskId === tasks.get('WRAP-OLD')?.id)).toHaveLength(1);
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('WRAP-NEXT')?.id)).toBe(false);
		releaseAgents(daemon, ['WRAP-NEW']);
		const newWrapup = await finishBatch(api, repo.repo, [tasks.get('WRAP-OLD')?.id ?? '', newId], batch.id);
		await waitFor('only new clean wrapup relays', async () => (await executionOf(api, docId)).currentBatchNo === 2, 60000);
		const completed = readPlan(daemon.dataDir, docId).find((entry) => entry.batchId === batch.id);
		expect(completed?.wrapupRunIds).toEqual([newWrapup.id]);
		expect(completed?.completion).toMatchObject({ completionFingerprint: completed?.membershipFingerprint });
		expect(readSnapshotInput(daemon.dataDir, newWrapup.id)).toMatchObject({ generationId: completed?.generationId, membershipFingerprint: completed?.membershipFingerprint });
		const dto = (await api.get(`/api/v1/batches/${batch.id}/wrapups`)).body.wrapups as Array<{ runId: string; tasks: string[] }>;
		expect(dto.find((row) => row.runId === oldWrapup?.id)?.tasks).toEqual(['WRAP-OLD']);
		expect(dto.find((row) => row.runId === newWrapup.id)?.tasks).toEqual(['WRAP-NEW', 'WRAP-OLD']);
	}, 360000);

	it('does not reuse a completed batch when the only implementation proves an older contract (E-369)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-missing-proof-');
		const path = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'PROOF', hash: 'proof-old' }]));
		await importThroughPage(page, path, repo.repo);
		const docId = await documentId(api);
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const task = (await taskIndex(api, docId)).get('PROOF');
		if (!task?.batchId) throw new Error('Proof task missing');
		await finishBatch(api, repo.repo, [task.id], task.batchId);
		await waitFor('old proof completed', async () => (await executionOf(api, docId)).state === 'completed');
		const old = readPlan(daemon.dataDir, docId)[0];
		expect(old?.completion).toBeTruthy();
		commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'PROOF', hash: 'proof-new' }]));
		await page.locator('[data-testid="import-doc-path"]').fill(path);
		await page.locator('[data-testid="import-repo-path"]').fill(repo.repo);
		await page.locator('[data-action="rebind-document"]').click();
		await page.locator('[data-action="confirm-document-source"]').click();
		writeControl(daemon, { implement: 'hold' });
		await page.locator('[data-action="start-document"]').click();
		await waitFor('new contract implementation', async () => (await listRuns(api)).filter((run) => run.kind === 'implement' && run.taskId === task.id).length === 2);
		const newRun = (await listRuns(api)).find((run) => run.kind === 'implement' && run.taskId === task.id && readRunSnapshot(daemon.dataDir, run.id).contract_hash === 'proof-new');
		expect(newRun).toBeDefined();
		const newPlan = readPlan(daemon.dataDir, docId)[0];
		expect(newPlan?.completion).toBeNull();
		expect(newPlan?.membershipFingerprint).not.toBe(old?.membershipFingerprint);
		expect((await executionOf(api, docId)).state).toBe('running');
		releaseAgents(daemon, ['all']);
		const wrapup = await finishBatch(api, repo.repo, [task.id], task.batchId);
		await waitFor('new contract proved', async () => (await executionOf(api, docId)).state === 'completed');
		expect(readPlan(daemon.dataDir, docId)[0]?.wrapupRunIds).toEqual([wrapup.id]);
	}, 360000);

	it.each([{ action: 'open', count: 2, valid: 2 }, { action: 'fail', count: 6, valid: 0 }])('preserves same-generation budget with $action reports across repeated controls (E-369)', async ({ action, count, valid }) => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-budget-');
		const path = commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'BUDGET', hash: 'budget' }]));
		await importThroughPage(page, path, repo.repo);
		const docId = await documentId(api);
		writeControl(daemon, { review: 'pass', wrapup: action });
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const task = (await taskIndex(api, docId)).get('BUDGET');
		if (!task?.batchId) throw new Error('Budget task missing');
		await landTasks(api, repo.repo, [task.id]);
		for (let attempt = 1; attempt <= count; attempt += 1) {
			await waitFor(`budget attempt ${attempt} finishes`, async () => {
				const runs = (await listRuns(api)).filter((run) => run.kind === 'wrapup');
				return runs.length === attempt && runs.every((run) => !['queued', 'starting', 'running'].includes(run.state));
			}, 60000);
			if (attempt < count) {
				const result = await api.post(`/api/v1/batches/${task.batchId}/wrapup`, { idempotencyKey: `budget-${attempt + 1}` });
				expect(result.status, JSON.stringify(result.body)).toBe(200);
			}
		}
		const execution = await executionOf(api, docId);
		expect(execution.wrapupProgress).toMatchObject({ physicalAttempts: count, validRounds: valid });
		const preserved = readPlan(daemon.dataDir, docId);
		const duplicate = { expectedVersion: execution.version, expectedFingerprint: execution.contentFingerprint, defaultAssignment: execution.defaultAssignment };
		expect((await api.post(`/api/v1/documents/${docId}/execution/start`, duplicate)).status).toBe(200);
		await page.locator('[data-action="pause-document"]').click();
		await waitFor('budget pause', async () => (await executionOf(api, docId)).state === 'paused');
		await page.locator('[data-action="resume-document"]').click();
		await waitFor('budget resume', async () => (await executionOf(api, docId)).state === 'running');
		await new Promise((resolveWait) => setTimeout(resolveWait, 5500));
		expect(readPlan(daemon.dataDir, docId)).toEqual(preserved);
		expect((await executionOf(api, docId)).wrapupProgress).toEqual(execution.wrapupProgress);
		expect((await listRuns(api)).filter((run) => run.kind === 'wrapup')).toHaveLength(count);
		if (count === 6) {
			const seventh = await api.post(`/api/v1/batches/${task.batchId}/wrapup`, { idempotencyKey: 'forbidden-seventh' });
			expect(seventh.status).toBe(409);
			expect(seventh.body.error).toMatchObject({ code: 'E_WRAPUP_ROUND_LIMIT', details: { physicalAttempts: 6 } });
			const oldGates = (await api.get('/api/v1/gates?pending=true')).body.gates as Array<{ id: string; runId: string }>;
			expect(oldGates.length).toBeGreaterThan(0);
			const gateId = oldGates[0]?.id ?? '';
			commitDocs(repo.repo, 'docs-data.js', renderDocs([{ id: 'BUDGET', hash: 'budget' }, { id: 'BUDGET-NEW', hash: 'budget-new' }]));
			expect((await api.post(`/api/v1/documents/${docId}/refresh`, {})).status).toBe(200);
			await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
			await page.locator('[data-action="confirm-document-source"]').click();
			writeControl(daemon, { implement: 'hold', wrapup: 'clean' });
			// A running plan with changed source remains paused until explicit resume.
			await page.locator('[data-action="resume-document"]').click();
			const newId = (await taskIndex(api, docId)).get('BUDGET-NEW')?.id ?? '';
			await waitForRun(api, newId, 'implement');
			const lateGate = await api.post(`/api/v1/gates/${gateId}/decide`, { decision: 'pass' });
			expect(lateGate.status).toBe(409);
			expect(lateGate.body.error).toMatchObject({ code: 'E_GATE_ALREADY_DECIDED' });
			expect((await executionOf(api, docId)).state).toBe('running');
			expect(readPlan(daemon.dataDir, docId)[0]?.completion).toBeNull();
		}
	}, 360000);

	it('runs a logged-in local Codex through the start button (E-370)', async (ctx) => {
		const where = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], {
			encoding: 'utf8',
		});
		const located =
			`${where.stdout ?? ''}`
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? '';
		const script = process.env.AGSCHED_REAL_CODEX_SCRIPT ?? (located ? join(dirname(located), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : '');
		const recordPath = join(artifactsDir, 'document-execution-real-agent.json');
		mkdirSync(artifactsDir, { recursive: true });
		if (!script || !existsSync(script)) {
			writeFileSync(recordPath, JSON.stringify({ skipped: true, reason: 'codex.js was not on PATH' }), 'utf8');
			ctx.skip();
			return;
		}
		const loginResult = spawnSync(process.execPath, [script, 'login', 'status'], {
			encoding: 'utf8',
			timeout: 30000,
		});
		const login = `${loginResult.stdout ?? ''}\n${loginResult.stderr ?? ''}`.trim();
		const loggedIn =
			loginResult.status === 0 && !/not logged|login required|not authenticated/i.test(login);
		if (!loggedIn) {
			writeFileSync(
				recordPath,
				JSON.stringify({ skipped: true, reason: 'codex login status did not report Logged in', login }),
				'utf8',
			);
			ctx.skip();
			return;
		}
		const version = spawnSync(process.execPath, [script, '--version'], { encoding: 'utf8', timeout: 30000 });
		expect(version.status).toBe(0);
		const modelName = process.env.AGSCHED_REAL_CODEX_MODEL ?? 'gpt-6.1-sol';
		writeFileSync(recordPath, JSON.stringify({ skipped: false, status: 'running', version: `${version.stdout ?? ''}`.trim(), modelName, effort: { tier: 'low' } }, null, 2));
		const daemon = await startDocumentDaemon({ agentScript: script, startupTimeoutMs: 180000 });
		active.daemon = daemon;
		const token = await claimAdmin(daemon);
		const api = apiFor(daemon, token);
		const browser = await openBrowser();
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		active.daemon = daemon;
		active.page = page;
		await pairPage(page, daemon, token);
		await configureAutoPipeline(api);
		const agentsPath = join(daemon.dataDir, 'agents.json');
		const registry = JSON.parse(readFileSync(agentsPath, 'utf8'));
		registry.overrides.codex.defaultModel = modelName;
		writeFileSync(agentsPath, JSON.stringify(registry));
		expect((await api.post('/api/v1/agents/codex/probe', {})).status).toBe(200);
		const repo = createRepo('agsched-doc-exec-real-');
		const docsPath = commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				{
					id: 'DE-REAL',
					hash: 'hash-real',
					paths: ['hello.txt'],
					accept: '1) hello.txt exists and contains exactly hello followed by one newline.',
					review: 'Read hello.txt in this worktree and verify exactly hello followed by one newline. This file is the entire allowed task path. Do not change any files. Start the final report with a standalone line VERDICT: pass only if the check succeeds; otherwise use VERDICT: rework or VERDICT: doc-issue and explain the failed check.',
					implement:
						'在当前工作树新增 hello.txt，内容只有一行 hello。写完文件后立刻停止。不要运行 git，不要提交，不要推送，不要询问许可。',
				},
			]),
		);
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		const nativeFrames = join(repoRoot, '.playwright-mcp', `gif-frames-m1-t12-native-${Date.now()}`);
		mkdirSync(nativeFrames, { recursive: true });
		await page.locator('[data-testid="document-execution"][data-execution-state="idle"]').waitFor();
		await page.screenshot({ path: join(nativeFrames, '00-idle.png') });
		await chooseAgent(page, 'codex');
		await page.locator('[data-testid="document-execution"] [data-testid="model-picker"] [data-testid="grouped-select-trigger"]').click();
		const modelOption = page.locator(`[data-testid="select-option-${modelName}"]`).first();
		if (await modelOption.isVisible().catch(() => false)) await modelOption.click();
		else {
			await page.locator('[data-testid="select-option-__manual_custom_model__"]').click();
			const custom = page.locator('[data-testid="grouped-select-custom-input"]');
			await custom.fill(modelName);
			await custom.press('Enter');
		}
		await page.locator('[data-testid="document-execution"] [data-testid="effort-picker"] [data-testid="grouped-select-trigger"]').click();
		await page.locator('[data-testid="select-option-tier:low"]').click();
		expect(await page.locator('[data-action="start-document"]').isEnabled()).toBe(true);
		await page.screenshot({ path: join(nativeFrames, '01-configured.png') });
		await page.locator('[data-action="start-document"]').click();
		await page.locator('[data-testid="document-execution"][data-execution-state="running"]').waitFor();
		await page.screenshot({ path: join(nativeFrames, '02-started.png') });
		const tasks = await taskIndex(api, docId);
		const taskId = tasks.get('DE-REAL')?.id ?? '';
		await waitFor(
			'real implement to leave the slot',
			async () => {
				const runs = (await listRuns(api)).filter((run) => run.taskId === taskId);
				const implementation = runs.find((run) => run.kind === 'implement');
				if (implementation && ['failed', 'aborted', 'interrupted', 'orphaned', 'awaiting_human'].includes(implementation.state)) {
					writeFileSync(recordPath, JSON.stringify({ skipped: false, status: 'failed', version: `${version.stdout ?? ''}`.trim(), modelName, effort: { tier: 'low' }, runs }, null, 2));
					throw new Error(`Native implementation did not pass: ${JSON.stringify(runs)}`);
				}
				return implementation?.state === 'landed';
			},
			480000,
		);
		await waitFor(
			'real review to finish',
			async () =>
				(await listRuns(api)).some(
					(run) =>
						run.taskId === taskId &&
						run.kind === 'review' &&
						run.state === 'exited' && run.exitCode === 0 && run.reviewVerdict === 'pass',
				),
			360000,
		);
		const runs = (await listRuns(api)).filter((run) => run.taskId === taskId);
		const implementations = runs.filter((run) => run.kind === 'implement');
		const reviews = runs.filter((run) => run.kind === 'review');
		expect(implementations).toHaveLength(1);
		expect(reviews).toHaveLength(1);
		expect(implementations[0]?.attemptNo).toBe(1);
		expect(implementations[0]?.state).toBe('landed');
		expect(implementations[0]?.exitCode).toBe(0);
		expect(reviews[0]).toMatchObject({ state: 'exited', exitCode: 0, reviewVerdict: 'pass', parentRunId: implementations[0]?.id });
		for (const run of [...implementations, ...reviews]) {
			expect(run.modelName).toBe(modelName);
			expect(run.effortTier ?? run.effort?.tier).toBe('low');
			expect(readRunSnapshot(daemon.dataDir, run.id).assignment).toMatchObject({ modelName, effortTier: 'low', effortVendor: null });
		}
		expect(readFileSync(join(implementations[0]?.worktreePath ?? '', 'hello.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello\n');
		expect(readFileSync(daemon.journalPath, 'utf8').trim()).toBe('');
		const reviewText = readAgentMessages(daemon.dataDir, reviews[0]?.id ?? '');
		expect(reviewText).toMatch(/^VERDICT:\s*pass\s*$/im);
		await page.screenshot({ path: join(artifactsDir, 'real-agent-success.png'), fullPage: true });
		await page.locator('[data-blocker="awaiting_landing"]').waitFor({ state: 'visible', timeout: 30000 });
		await page.screenshot({ path: join(nativeFrames, '03-accepted.png') });
		await page.goto(`http://127.0.0.1:${daemon.port}/#/run/${reviews[0]?.id}`, { waitUntil: 'domcontentloaded' });
		await page.locator('[data-testid="run-detail-page"]').waitFor();
		await page.locator(`[data-run-id="${reviews[0]?.id}"]`).waitFor();
		await page.screenshot({ path: join(nativeFrames, '04-review.png') });
		writeFileSync(
			recordPath,
			JSON.stringify(
				{
					skipped: false,
					status: 'passed',
					browserEvidence: { frames: nativeFrames, origin: `http://127.0.0.1:${daemon.port}`,
						browser: 'repository Playwright, headless Chromium, fresh isolated context',
						mode: 'AGSCHED_DEV=1; production bootstrap and native Codex CLI; no fixture Agent, transport or event injection' },
					reviewText,
					snapshots: [...implementations, ...reviews].map((run) => {
						const snapshot = readRunSnapshot(daemon.dataDir, run.id);
						return { runId: run.id, contractHash: snapshot.contract_hash, assignment: snapshot.assignment };
					}),
					version: `${version.stdout ?? ''}`.trim(), modelName, effort: { tier: 'low' },
					steps: ['production bootstrap', 'normal browser pairing', 'import idle document', 'choose Codex, explicit model and low effort', 'one start button', 'one implementation exits 0', 'one read-only review exits 0 with pass', 'implementation landed'],
					login: login.trim(),
					script,
					runs: runs.map((run) => ({
						kind: run.kind,
						id: run.id, parentRunId: run.parentRunId, attemptNo: run.attemptNo,
						state: run.state,
						exitCode: run.exitCode, verdict: run.reviewVerdict, effort: run.effort,
						modelName: run.modelName ?? null,
						reportedModel: run.reportedModel ?? null,
						agentId: run.agentId,
					})),
				},
				null,
				2,
			),
			'utf8',
		);
	}, 960000);

	it('does not intercept fetch, write the database, or install a production test hook (E-370)', () => {
		const harness = readFileSync(join(repoRoot, 'e2e/helpers/document-execution-harness.ts'), 'utf8');
		const test = readFileSync(join(repoRoot, 'e2e/document-execution.test.ts'), 'utf8');
		const routeCall = ['page', 'route('].join('.');
		expect(harness).not.toContain(routeCall);
		expect(test).not.toContain(routeCall);
		expect(test).not.toContain(['sessionStorage', 'setItem'].join('.'));
		expect(harness).not.toContain('.prepare(`INSERT');
		expect(harness).not.toContain('.prepare(`UPDATE');
		const workflow = readFileSync(join(repoRoot, '.github/workflows/desktop-ci.yml'), 'utf8');
		expect(workflow).toContain('document-execution-e2e');
		expect(workflow).toContain('e2e/artifacts/**');
		expect(workflow).toContain('windows-latest');
		expect(workflow).toContain('macos-latest');
		expect(workflow).toContain('ubuntu-latest');
	});
});

async function waitForRun(api: DocumentApi, taskId: string, kind: string): Promise<ListedRun> {
	let found: ListedRun | undefined;
	await waitFor(`${kind} run`, async () => {
		found = (await listRuns(api)).find((run) => run.taskId === taskId && run.kind === kind);
		return !!found;
	});
	if (!found) throw new Error(`${kind} run was not created`);
	return found;
}

async function restartDaemon(dataDir: string, port: number): Promise<RunningDaemon> {
	const { spawn } = await import('node:child_process');
	writeFileSync(join(dataDir, 'restart-port'), String(port), 'utf8');
	const child = spawn(process.execPath, [join(repoRoot, 'packages/daemon/bootstrap.mjs')], {
		cwd: repoRoot,
		env: {
			...process.env,
			AGSCHED_PORT: String(port),
			AGSCHED_DATA_DIR: dataDir,
			AGSCHED_BIND: '127.0.0.1',
			AGSCHED_LOG_LEVEL: 'info',
			AGSCHED_DEV: '1',
			AGSCHED_DOC_EXEC_CONTROL: join(dataDir, 'control.json'),
			AGSCHED_DOC_EXEC_JOURNAL: join(dataDir, 'agent-journal.ndjson'),
			AGSCHED_DOC_EXEC_RELEASE: join(dataDir, 'release.txt'),
			AGSCHED_DOC_EXEC_NODE: process.execPath,
			AGSCHED_DOC_EXEC_SCRIPT: join(repoRoot, 'e2e/fixtures/document-execution-agent.mjs'),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const stdoutPath = join(dataDir, 'daemon.stdout.log');
	const stderrPath = join(dataDir, 'daemon.stderr.log');
	let stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '';
	let stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
	child.stdout?.on('data', (chunk) => {
		stdout += chunk.toString();
		writeFileSync(stdoutPath, stdout, 'utf8');
	});
	child.stderr?.on('data', (chunk) => {
		stderr += chunk.toString();
		writeFileSync(stderrPath, stderr, 'utf8');
	});
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
			if (response.ok) {
				return {
					port,
					dataDir,
					controlPath: join(dataDir, 'control.json'),
					journalPath: join(dataDir, 'agent-journal.ndjson'),
					releasePath: join(dataDir, 'release.txt'),
					stdoutPath,
					stderrPath,
					getStdout: () => stdout,
					getStderr: () => stderr,
					async stop() {
						if (child.exitCode === null) {
							child.kill('SIGTERM');
							await Promise.race([
								new Promise((resolveExit) => child.once('exit', resolveExit)),
								new Promise((resolveExit) => setTimeout(resolveExit, 4000)),
							]);
						}
						rmSync(dataDir, { recursive: true, force: true });
					},
				};
			}
		} catch {
			// waiting
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	child.kill('SIGTERM');
	throw new Error(`Restarted daemon did not become healthy\n${stderr}`);
}
