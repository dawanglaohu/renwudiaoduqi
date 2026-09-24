import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HostVerificationResult, assertReleaseVerification } from '../src/platform-support.ts';

/**
 * Evaluates the release matrix from the real job and step conclusions GitHub reports
 * for the current workflow run (AC 1, AC 6, E-265, E-267). Every platform and every
 * step is read from the API; nothing is assumed from the aggregate `needs` result, so a
 * failing platform is named together with the step that failed.
 *
 * Usage: node launchers/evaluate-release-gate.ts <jobs.json>
 *   jobs.json is the response of GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs.
 *   FORMAL_RELEASE=true enforces the macOS signing/notarization gate.
 *   SIGNING_GATE_RESULT carries the conclusion of the signing gate job (success/skipped/…).
 */

interface WorkflowStep {
	readonly name: string;
	readonly conclusion: string | null;
}

interface WorkflowJob {
	readonly name: string;
	readonly conclusion: string | null;
	readonly steps?: readonly WorkflowStep[];
}

const PLATFORM_JOB_MARKERS = {
	win32: 'Desktop CI / Windows',
	darwin: 'Desktop CI / macOS',
	linux: 'Desktop CI / Linux',
} as const;

const STEP_MARKERS = {
	workspaceCheck: 'Workspace Verification Check',
	platformTests: 'Platform Integration Tests',
	smoke: 'Staged Unpack',
	shellBuild: 'Build Tauri Desktop Shell',
	// M10-T6: the real shell executable against the real shipped daemon. Its own step so a
	// platform that builds a shell it cannot actually start is named as such (E-257, E-265).
	shellSmoke: 'Desktop Shell Smoke',
} as const;

function stepPassed(job: WorkflowJob, marker: string): boolean {
	const step = job.steps?.find((candidate) => candidate.name.startsWith(marker));
	return step?.conclusion === 'success';
}

function failedSteps(job: WorkflowJob): string {
	const failed = (job.steps ?? [])
		.filter(
			(step) =>
				step.conclusion !== null && step.conclusion !== 'success' && step.conclusion !== 'skipped',
		)
		.map((step) => `${step.name} (${step.conclusion})`);
	return failed.length > 0 ? failed.join(', ') : `job ${job.conclusion ?? 'unfinished'}`;
}

export function collectHostResults(
	jobs: readonly WorkflowJob[],
	signing: { readonly isSigned: boolean; readonly isNotarized: boolean },
): HostVerificationResult[] {
	const results: HostVerificationResult[] = [];
	for (const [platform, marker] of Object.entries(PLATFORM_JOB_MARKERS) as [
		keyof typeof PLATFORM_JOB_MARKERS,
		string,
	][]) {
		const job = jobs.find((candidate) => candidate.name.startsWith(marker));
		if (!job) continue;
		const result: HostVerificationResult = {
			platform,
			hostLabel: job.name,
			workspaceCheckPassed: stepPassed(job, STEP_MARKERS.workspaceCheck),
			platformTestsPassed: stepPassed(job, STEP_MARKERS.platformTests),
			smokePassed: stepPassed(job, STEP_MARKERS.smoke),
			shellBuildPassed: stepPassed(job, STEP_MARKERS.shellBuild),
			shellSmokePassed: stepPassed(job, STEP_MARKERS.shellSmoke),
			failureReason: job.conclusion === 'success' ? undefined : failedSteps(job),
			...(platform === 'darwin' ? signing : {}),
		};
		results.push(result);
	}
	return results;
}

const isDirectExecution =
	Boolean(process.argv[1]) && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (isDirectExecution) {
	const jobsFile = process.argv[2];
	if (!jobsFile) {
		console.error('usage: evaluate-release-gate.ts <jobs.json>');
		process.exit(2);
	}
	const payload = JSON.parse(readFileSync(jobsFile, 'utf8')) as { jobs?: WorkflowJob[] };
	const jobs = payload.jobs ?? [];
	const isFormal = process.env.FORMAL_RELEASE === 'true';
	const signingSatisfied = process.env.SIGNING_GATE_RESULT === 'success';
	const results = collectHostResults(jobs, {
		isSigned: signingSatisfied,
		isNotarized: signingSatisfied,
	});

	for (const result of results) {
		console.log(
			`[release-gate] ${result.platform.padEnd(6)} check=${result.workspaceCheckPassed} platform-tests=${result.platformTestsPassed} smoke=${result.smokePassed} shell-build=${result.shellBuildPassed} shell-smoke=${result.shellSmokePassed}${result.failureReason ? ` :: ${result.failureReason}` : ''}`,
		);
	}
	try {
		assertReleaseVerification(results, { isFormalRelease: isFormal });
	} catch (error) {
		console.error(`[release-gate] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	console.log(
		`[release-gate] Three-platform matrix passed${isFormal ? ' (formal release, macOS signed and notarized)' : ' (build verification; macOS artifacts are 构建验证件)'}.`,
	);
}
