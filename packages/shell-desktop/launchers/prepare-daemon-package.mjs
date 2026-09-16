// Prepares the deployed daemon distribution carried inside the desktop installation
// (AC 2, E-209). `pnpm deploy` resolves the daemon plus its runtime dependencies into a
// single tree; this script trims that tree to the one platform the product ships and
// removes the package-manager metadata that only means something on the build machine.
//
// Usage: node launchers/prepare-daemon-package.mjs <deployDir>
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const deployDir = process.argv[2];
if (!deployDir) {
	console.error('usage: prepare-daemon-package.mjs <deployDir>');
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(deployDir, 'package.json'), 'utf8'));
if (manifest.name !== '@agent-scheduler/daemon') {
	console.error(`unexpected deployed package: ${manifest.name}`);
	process.exit(1);
}

const modulesDir = join(deployDir, 'node_modules');
// The Node runtime packages use `win` (not `win32`) in their directory names.
const packagePlatform = process.platform === 'win32' ? 'win' : process.platform;
const keepRuntime = `node22-${packagePlatform}-${process.arch}`;
let keptRuntime = false;

for (const entry of readdirSync(modulesDir)) {
	if (!/^node\d+-/.test(entry)) continue;
	if (entry === keepRuntime) {
		keptRuntime = true;
		continue;
	}
	rmSync(join(modulesDir, entry), { recursive: true, force: true });
}
if (!keptRuntime) {
	console.error(`the deployed daemon does not bundle a runtime for ${keepRuntime} (E-257)`);
	process.exit(1);
}

// Package-manager metadata records the build machine's absolute paths and is not part
// of the product; the installer must not carry it.
for (const entry of ['.pnpm', '.bin', '.modules.yaml']) {
	rmSync(join(modulesDir, entry), { recursive: true, force: true });
}
rmSync(join(deployDir, 'tsconfig.tsbuildinfo'), { force: true });

const entryPath = join(deployDir, 'bootstrap.mjs');
if (!statSync(entryPath).isFile()) {
	console.error('the deployed daemon is missing bootstrap.mjs');
	process.exit(1);
}

console.log(`prepared daemon distribution at ${deployDir} (runtime: ${keepRuntime})`);
