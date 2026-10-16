import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type DocumentApi,
	type ListedRun,
	type RunningDaemon,
	apiFor,
	artifactsDir,
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
	readSnapshotInput,
	readWrapupRows,
	clearRelease,
	releaseAgents,
	renderDocs,
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

afterEach(async (ctx) => {
	if (ctx.task.result?.state === 'fail') {
		const name = ctx.task.name.replace(/[^\w.-]+/g, '_').slice(0, 80);
		await captureFailure(active.page, active.daemon, name);
	}
	await active.page?.context().browser()?.close().catch(() => undefined);
	await active.daemon?.stop().catch(() => undefined);
	active.page = null;
	active.daemon = null;
});

async function boot() {
	const daemon = await startDocumentDaemon();
	const token = await claimAdmin(daemon);
	const api = apiFor(daemon, token);
	const browser = await openBrowser();
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await pairPage(page, daemon, token);
	active.daemon = daemon;
	active.page = page;
	return { daemon, api, page, browser };
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

async function finishBatch(
	api: DocumentApi,
	repo: string,
	taskIds: readonly string[],
	batchId: string,
	beforeWrapupMerge?: () => void,
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
		30000,
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
		30000,
	);
	const implementRuns = (await listRuns(api)).filter(
		(run) => run.kind === 'implement' && taskIds.includes(run.taskId ?? ''),
	);
	for (const run of implementRuns) {
		if (run.worktreePath) rmSync(join(run.worktreePath, 'untracked-diff.txt'), { force: true });
		if (run.branchName) await mergeWhenReady(repo, run.branchName);
	}
	try {
		await waitFor(
			'wrapup run',
			async () => (await listRuns(api)).some((run) => run.kind === 'wrapup' && run.batchId === batchId),
			150000,
		);
	} catch (error) {
		const runs = await listRuns(api);
		const summary = runs
			.map((run) => `${run.kind}:${run.state}:${run.taskId ?? run.batchId ?? ''}`)
			.join(',');
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message} [${summary}]`);
	}
	await waitFor(
		'wrapup to finish',
		async () => {
			const run = (await listRuns(api)).find((item) => item.kind === 'wrapup' && item.batchId === batchId);
			return !!run && !['queued', 'starting', 'running'].includes(run.state);
		},
		30000,
	);
	beforeWrapupMerge?.();
	const wrapup = (await listRuns(api)).find((run) => run.kind === 'wrapup' && run.batchId === batchId);
	if (wrapup?.branchName) await mergeWhenReady(repo, wrapup.branchName);
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

	it('rejects an unknown agent, waits out an outage, and keeps a drafted sibling moving (E-362, E-365)', async () => {
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
		const fingerprint = (await executionOf(api, docId)).contentFingerprint;
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

		await page.locator('[data-action="pause-document"]').click();
		await waitFor('paused while waiting', async () => (await executionOf(api, docId)).state === 'paused');
		writeFileSync(agentsPath, saved, 'utf8');
		await page.locator('[data-action="refresh-agent"]').click();
		await page.locator('[data-testid="probe-agent-btn-codex"]').click();
		await page.goto(`http://127.0.0.1:${daemon.port}/#/`, { waitUntil: 'domcontentloaded' });
		await new Promise((resolveWait) => setTimeout(resolveWait, 6000));
		expect((await listRuns(api)).some((run) => run.taskId === tasks.get('DE-WAIT')?.id)).toBe(false);

		await page.locator('[data-action="resume-document"]').click();
		await waitFor('default agent resumes', async () =>
			(await listRuns(api)).some((run) => run.taskId === tasks.get('DE-WAIT')?.id && run.agentId === 'codex'),
		);
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

	it('restarts paused and does not redispatched a failed, aborted, or interrupted task (E-368)', async () => {
		const { daemon, api, page } = await boot();
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-restart-');
		const docsPath = commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				{ id: 'DE-FAIL', hash: 'hash-fail' },
				{ id: 'DE-HOLD', hash: 'hash-hold' },
				{ id: 'DE-LATER', hash: 'hash-later' },
			]),
		);
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		await setLaneCount(api, docId, 3);
		writeControl(daemon, {
			tasks: { 'DE-FAIL': 'fail', 'DE-HOLD': 'hold', 'DE-LATER': 'hold' },
			review: 'pass',
			wrapup: 'clean',
		});
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const terminal = new Set(['failed', 'aborted', 'interrupted', 'orphaned', 'exited', 'awaiting_human']);
		await waitFor('failed implement to leave the slot', async () =>
			(await listRuns(api)).some(
				(run) => run.taskId === tasks.get('DE-FAIL')?.id && run.kind === 'implement' && terminal.has(run.state),
			),
		);
		const hold = await waitForRun(api, tasks.get('DE-HOLD')?.id ?? '', 'implement');
		const abort = await api.post(`/api/v1/runs/${hold.id}/abort`, {});
		expect(abort.status).toBe(200);
		const later = await waitForRun(api, tasks.get('DE-LATER')?.id ?? '', 'implement');
		expect(later.state === 'running' || later.state === 'starting').toBe(true);
		if (later.pid && later.pid > 0) {
			try {
				process.kill(later.pid);
			} catch {
				// The restart reconciler still classifies a dead or living pid.
			}
		}
		const dataDir = daemon.dataDir;
		const port = daemon.port;
		await daemon.stop({ keepData: true });
		const restarted = await restartDaemon(dataDir, port);
		active.daemon = restarted;
		const next = apiFor(restarted, api.token);
		await page.goto(`http://127.0.0.1:${port}/#/`, { waitUntil: 'domcontentloaded' });
		await waitFor('restart pause', async () => {
			const execution = await executionOf(next, docId);
			return execution.state === 'paused' && execution.pauseReason === 'daemon_restarted';
		});
		await waitFor('restart reason on the page', async () => {
			const retrySnapshot = page.locator('[data-testid="retry-snapshot"]');
			if (await retrySnapshot.isVisible().catch(() => false)) await retrySnapshot.click();
			const text = await page
				.locator('[data-testid="document-execution-state"]')
				.innerText()
				.catch(() => '');
			return text.includes('调度服务重启后已暂停');
		}, 20000);
		const before = (await listRuns(next)).filter((run) => run.kind === 'implement').length;
		await page.locator('[data-action="confirm-document-source"]').click();
		await page.locator('[data-action="resume-document"]').click();
		await new Promise((resolveWait) => setTimeout(resolveWait, 8000));
		const after = await listRuns(next);
		expect(after.filter((run) => run.taskId === tasks.get('DE-FAIL')?.id && run.kind === 'implement')).toHaveLength(
			1,
		);
		expect(after.filter((run) => run.taskId === tasks.get('DE-HOLD')?.id && run.kind === 'implement')).toHaveLength(
			1,
		);
		expect(after.filter((run) => run.kind === 'implement').length).toBe(before);
	}, 180000);

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
		await page.locator('[data-action="start-document"]').click();
		await waitFor('new member run', async () =>
			(await listRuns(api)).some((run) => run.kind === 'implement' && run.state !== 'failed' && run.taskId !== tasks.get('DE-OLD')?.id && run.taskId !== tasks.get('DE-DONE')?.id),
		);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement' && run.taskId === tasks.get('DE-OLD')?.id)).toHaveLength(1);
		expect((await listRuns(api)).filter((run) => run.kind === 'implement').length).toBe(oldRuns + 1);
		expect((await executionOf(api, docId)).state).not.toBe('completed');
		const rows = readWrapupRows(daemon.dataDir, second.id);
		for (const row of rows) {
			const parsed = JSON.parse(String(row.tasks_json)) as unknown;
			expect(Array.isArray(parsed)).toBe(true);
			expect((parsed as unknown[]).every((item) => typeof item === 'string')).toBe(true);
		}
	}, 240000);

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
			.at(-1);
		if (wrapup?.branchName) await mergeWhenReady(repo.repo, wrapup.branchName);
		await waitFor('generation document completed', async () => (await executionOf(api, docId)).state === 'completed');
		const frozen = wrapup ? readSnapshotInput(daemon.dataDir, wrapup.id) : null;
		expect(frozen?.membershipFingerprint).toEqual(expect.any(String));
		expect(JSON.stringify(frozen)).not.toContain('"tasks":');

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
		await page.locator('[data-action="start-document"]').click();
		await waitFor('new generation dispatch', async () => {
			const progress = (await executionOf(api, docId)).wrapupProgress as { generationId?: number } | null;
			return (await listRuns(api)).some((run) => run.kind === 'implement' && run.state !== 'failed') &&
				(progress === null || progress.generationId !== generationId);
		});
		const again = await executionOf(api, docId);
		expect((again.wrapupProgress as { physicalAttempts?: number } | null)?.physicalAttempts ?? 0).toBeLessThan(5);
	}, 300000);

	it('runs a logged-in local Codex through the start button (E-370)', async () => {
		const where = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], {
			encoding: 'utf8',
		});
		const located =
			`${where.stdout ?? ''}`
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? '';
		const script = located ? join(dirname(located), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : '';
		const recordPath = join(artifactsDir, 'document-execution-real-agent.json');
		mkdirSync(artifactsDir, { recursive: true });
		if (!script || !existsSync(script)) {
			writeFileSync(recordPath, JSON.stringify({ skipped: true, reason: 'codex.js was not on PATH' }), 'utf8');
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
			return;
		}
		const daemon = await startDocumentDaemon({ agentScript: script });
		const token = await claimAdmin(daemon);
		const api = apiFor(daemon, token);
		const browser = await openBrowser();
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		active.daemon = daemon;
		active.page = page;
		await pairPage(page, daemon, token);
		await configureAutoPipeline(api);
		const repo = createRepo('agsched-doc-exec-real-');
		const docsPath = commitDocs(
			repo.repo,
			'docs-data.js',
			renderDocs([
				{
					id: 'DE-REAL',
					hash: 'hash-real',
					implement:
						'在当前工作树新增 hello.txt，内容只有一行 hello。写完文件后立刻停止。不要运行 git，不要提交，不要推送，不要询问许可。',
				},
			]),
		);
		await importThroughPage(page, docsPath, repo.repo);
		const docId = await documentId(api);
		await chooseAgent(page, 'codex');
		await page.locator('[data-action="start-document"]').click();
		const tasks = await taskIndex(api, docId);
		const taskId = tasks.get('DE-REAL')?.id ?? '';
		await waitFor(
			'real implement to leave the slot',
			async () =>
				(await listRuns(api)).some(
					(run) => run.taskId === taskId && run.kind === 'implement' && !occupies(run),
				),
			480000,
		);
		await waitFor(
			'real review to finish',
			async () =>
				(await listRuns(api)).some(
					(run) =>
						run.taskId === taskId &&
						run.kind === 'review' &&
						!['queued', 'starting', 'running'].includes(run.state),
				),
			360000,
		);
		const runs = (await listRuns(api)).filter((run) => run.taskId === taskId);
		writeFileSync(
			recordPath,
			JSON.stringify(
				{
					skipped: false,
					login: login.trim(),
					script,
					runs: runs.map((run) => ({
						kind: run.kind,
						state: run.state,
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
		expect(runs.some((run) => run.kind === 'implement' && run.state !== 'failed')).toBe(true);
		expect(runs.some((run) => run.kind === 'review')).toBe(true);
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

