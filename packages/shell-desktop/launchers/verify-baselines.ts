import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUpstreamBaselineSync } from '../src/platform-support.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

export function runBaselineVerification(root = repoRoot): {
	ok: boolean;
	issues: readonly string[];
} {
	const packageJsonPath = resolve(root, 'package.json');
	const cargoTomlPath = resolve(root, 'packages/shell-desktop/src-tauri/Cargo.toml');
	const ciWorkflowPath = resolve(root, '.github/workflows/desktop-ci.yml');
	const platformDocPath = resolve(root, 'docs/platform-support.md');
	const runtimeManifestPath = resolve(root, 'packages/shell-desktop/daemon-runtime.json');

	const issues: string[] = [];

	if (!existsSync(packageJsonPath)) issues.push(`Missing package.json at ${packageJsonPath}`);
	if (!existsSync(cargoTomlPath)) issues.push(`Missing Cargo.toml at ${cargoTomlPath}`);
	if (!existsSync(ciWorkflowPath)) issues.push(`Missing CI workflow at ${ciWorkflowPath}`);
	if (!existsSync(platformDocPath)) issues.push(`Missing docs at ${platformDocPath}`);
	if (!existsSync(runtimeManifestPath)) {
		issues.push(`Missing daemon runtime manifest at ${runtimeManifestPath}`);
	}

	if (issues.length > 0) {
		return { ok: false, issues };
	}

	const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
	const cargoTomlContent = readFileSync(cargoTomlPath, 'utf8');
	const ciWorkflowContent = readFileSync(ciWorkflowPath, 'utf8');
	const platformDocContent = readFileSync(platformDocPath, 'utf8');
	const daemonRuntimeManifestContent = readFileSync(runtimeManifestPath, 'utf8');

	const report = validateUpstreamBaselineSync({
		packageJsonContent,
		cargoTomlContent,
		ciWorkflowContent,
		platformDocContent,
		daemonRuntimeManifestContent,
	});

	return {
		ok: report.synchronized,
		issues: report.issues,
	};
}

const isDirectExecution =
	Boolean(process.argv[1]) && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (isDirectExecution) {
	const result = runBaselineVerification();
	if (result.ok) {
		console.log(
			'[verify-baselines] Upstream baselines (Node >=22, Tauri v2, OS matrices) synchronized.',
		);
		process.exit(0);
	} else {
		console.error('[verify-baselines] Baseline synchronization check failed (E-260):');
		for (const issue of result.issues) {
			console.error(`  - ${issue}`);
		}
		process.exit(1);
	}
}
