// Builds the daemon distribution the desktop installation carries under
// `<resource_dir>/daemon-runtime` (AC 2, E-209, E-257, E-260).
//
// `pnpm deploy --prod` resolves the daemon plus its runtime dependencies into a single
// tree. This script then adds the Node runtime the product ships (the daemon is an ESM
// application that needs Node >= 22, see `bootstrap.mjs`), trims the tree to this one
// platform, and removes the package-manager metadata that only means something on the
// build machine. The output is what `tauri.conf.json` lists under `bundle.resources`.
//
// Usage: node scripts/build-daemon-distribution.mjs [outputDir]
//   outputDir defaults to src-tauri/gen/daemon-runtime (git-ignored, biome-ignored).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const shellPackageDir = resolve(scriptDir, '..');
const repoRoot = resolve(shellPackageDir, '../..');
const runtimeManifestPath = join(shellPackageDir, 'daemon-runtime.json');
const outputDir = resolve(
	process.argv[2] ?? join(shellPackageDir, 'src-tauri', 'gen', 'daemon-runtime'),
);

const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));
const nodeVersion = runtimeManifest.node;
const downloadHost = runtimeManifest.downloadHost;
if (typeof nodeVersion !== 'string' || !/^22\.\d+\.\d+$/.test(nodeVersion)) {
	console.error(`daemon-runtime.json must pin a Node 22 version, got ${String(nodeVersion)}`);
	process.exit(1);
}
const nodeMajor = nodeVersion.split('.')[0];

/** npm and nodejs.org both call the Windows platform `win`. */
const packagePlatform = process.platform === 'win32' ? 'win' : process.platform;
const arch = process.arch;
const runtimeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node';

function fail(message) {
	console.error(`[build-daemon-distribution] ${message}`);
	process.exit(1);
}

function deployDaemon() {
	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(dirname(outputDir), { recursive: true });
	const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
	const result = spawnSync(
		pnpm,
		[
			'--filter',
			'@agent-scheduler/daemon',
			'deploy',
			'--legacy',
			'--prod',
			'--config.node-linker=hoisted',
			outputDir,
		],
		{ cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' },
	);
	if (result.status !== 0) fail(`pnpm deploy exited with ${result.status}`);
	const manifest = JSON.parse(readFileSync(join(outputDir, 'package.json'), 'utf8'));
	if (manifest.name !== '@agent-scheduler/daemon')
		fail(`unexpected deployed package ${manifest.name}`);
	if (!statSync(join(outputDir, 'bootstrap.mjs')).isFile())
		fail('deployed daemon lacks bootstrap.mjs');
}

function request(url) {
	return new Promise((resolvePromise, reject) => {
		const req = get(url, (response) => {
			if (
				response.statusCode &&
				response.statusCode >= 300 &&
				response.statusCode < 400 &&
				response.headers.location
			) {
				response.resume();
				request(new URL(response.headers.location, url).toString()).then(resolvePromise, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`GET ${url} returned ${response.statusCode}`));
				return;
			}
			resolvePromise(response);
		});
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error(`timed out fetching ${url}`)));
	});
}

async function fetchText(url) {
	const response = await request(url);
	return new Promise((resolvePromise, reject) => {
		let text = '';
		response.setEncoding('utf8');
		response.on('data', (chunk) => {
			text += chunk;
		});
		response.on('end', () => resolvePromise(text));
		response.on('error', reject);
	});
}

async function download(url, destination) {
	const response = await request(url);
	await new Promise((resolvePromise, reject) => {
		const file = createWriteStream(destination);
		response.pipe(file);
		file.on('finish', () => file.close(() => resolvePromise()));
		file.on('error', reject);
		response.on('error', reject);
	});
}

function sha256(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function extract(archive, targetDir) {
	// Run tar inside the scratch directory with relative names: a drive-letter path such
	// as `C:\...` is read as a remote host by the tar shipped with Git for Windows.
	const args = archive.endsWith('.zip') ? ['-xf', basename(archive)] : ['-xzf', basename(archive)];
	const result = spawnSync('tar', args, { cwd: targetDir, stdio: 'inherit' });
	if (result.status !== 0) fail(`failed to extract ${basename(archive)} (exit ${result.status})`);
}

/**
 * Uses the runtime package pnpm already hoisted (`node<major>-<platform>-<arch>`) when it
 * matches the pinned version; otherwise fetches the official build for this platform and
 * verifies it against the published SHASUMS256 (npm has no darwin-arm64 package past 18).
 */
async function bundleRuntime() {
	const runtimeDir = join(outputDir, 'runtime');
	mkdirSync(runtimeDir, { recursive: true });
	const target = join(runtimeDir, runtimeBinaryName);

	const hoisted = join(outputDir, 'node_modules', `node${nodeMajor}-${packagePlatform}-${arch}`);
	const hoistedBinary = join(hoisted, 'bin', runtimeBinaryName);
	if (existsSync(hoistedBinary)) {
		// npm's runtime packages carry the `v` prefix in their version field.
		const hoistedVersion = String(
			JSON.parse(readFileSync(join(hoisted, 'package.json'), 'utf8')).version,
		).replace(/^v/, '');
		if (hoistedVersion === nodeVersion) {
			copyFileSync(hoistedBinary, target);
			console.log(
				`[build-daemon-distribution] bundled runtime from ${hoisted} (${hoistedVersion})`,
			);
			return target;
		}
		console.log(
			`[build-daemon-distribution] hoisted runtime ${hoistedVersion} differs from pinned ${nodeVersion}; fetching the pinned build`,
		);
	}

	const archiveName =
		process.platform === 'win32'
			? `node-v${nodeVersion}-win-${arch}.zip`
			: `node-v${nodeVersion}-${process.platform}-${arch}.tar.gz`;
	const base = `${downloadHost}/v${nodeVersion}`;
	const scratch = mkdtempSync(join(tmpdir(), 'agsched-node-runtime-'));
	try {
		const shasums = await fetchText(`${base}/SHASUMS256.txt`);
		const line = shasums.split('\n').find((entry) => entry.trim().endsWith(`  ${archiveName}`));
		if (!line) {
			fail(
				`no Node ${nodeVersion} build exists for ${process.platform}-${arch} (${base}/${archiveName}); the packaged product would depend on a runtime it does not ship (E-257)`,
			);
		}
		const expectedSha = line.trim().split(/\s+/)[0];
		const archive = join(scratch, archiveName);
		console.log(`[build-daemon-distribution] downloading ${base}/${archiveName}`);
		await download(`${base}/${archiveName}`, archive);
		const actualSha = sha256(archive);
		if (actualSha !== expectedSha) {
			fail(`SHA-256 mismatch for ${archiveName}: expected ${expectedSha}, got ${actualSha}`);
		}
		extract(archive, scratch);
		const extractedRoot = join(scratch, archiveName.replace(/\.(zip|tar\.gz)$/, ''));
		const source =
			process.platform === 'win32'
				? join(extractedRoot, runtimeBinaryName)
				: join(extractedRoot, 'bin', runtimeBinaryName);
		if (!existsSync(source)) fail(`the downloaded archive did not contain ${source}`);
		copyFileSync(source, target);
		console.log(
			`[build-daemon-distribution] bundled runtime ${nodeVersion} for ${process.platform}-${arch}`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return target;
}

function pruneDistribution() {
	const modulesDir = join(outputDir, 'node_modules');
	// Runtime packages for other platforms and the Node 20 fixtures used by the test
	// suite are build-machine content, not product content.
	for (const entry of readdirSync(modulesDir)) {
		if (/^node\d+-/.test(entry)) rmSync(join(modulesDir, entry), { recursive: true, force: true });
	}
	// linuxdeploy scans every ELF in the AppImage, including native prebuilds for
	// other platforms. Retain only the prebuild that this shipped Node can load.
	const prebuildsDir = join(modulesDir, 'better-sqlite3', 'prebuilds');
	const hostPrebuild = `${process.platform}-${arch}.node`;
	if (!existsSync(join(prebuildsDir, hostPrebuild))) {
		fail(`deployed better-sqlite3 lacks ${hostPrebuild}`);
	}
	for (const entry of readdirSync(prebuildsDir)) {
		if (entry !== hostPrebuild) rmSync(join(prebuildsDir, entry), { force: true });
	}
	// The upstream test fixture contains a snowman in its path. WiX's en-US MSI
	// database uses code page 1252 and cannot encode that non-product file.
	rmSync(join(modulesDir, '@fastify', 'send', 'test'), { recursive: true, force: true });
	// Package-manager metadata records the build machine's absolute paths.
	for (const entry of ['.pnpm', '.bin', '.modules.yaml', '.npmrc']) {
		rmSync(join(modulesDir, entry), { recursive: true, force: true });
	}
	rmSync(join(outputDir, 'tsconfig.tsbuildinfo'), { force: true });
	rmSync(join(outputDir, 'test'), { recursive: true, force: true });
	// pnpm deploy mirrors the output location back into the tree as an empty
	// `packages/shell-desktop/src-tauri/gen` chain; it is not product content.
	rmSync(join(outputDir, 'packages'), { recursive: true, force: true });
}

async function main() {
	deployDaemon();
	const runtime = await bundleRuntime();
	if (process.platform !== 'win32') {
		// The product starts this file directly, so the executable bit has to survive.
		chmodSync(runtime, 0o755);
	}
	pruneDistribution();
	const version = spawnSync(runtime, ['--version'], { encoding: 'utf8' });
	if (version.status !== 0 || version.stdout.trim() !== `v${nodeVersion}`) {
		fail(
			`bundled runtime does not report v${nodeVersion}: ${version.stdout.trim()} ${version.stderr.trim()}`,
		);
	}
	console.log(
		`[build-daemon-distribution] daemon distribution ready at ${outputDir} (Node ${nodeVersion}, ${process.platform}-${arch})`,
	);
}

await main();
