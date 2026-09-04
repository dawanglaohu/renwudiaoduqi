const REQUIRED_NODE_MAJOR = 22;
const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split('.')[0] ?? '', 10);

if (!Number.isInteger(currentMajor) || currentMajor < REQUIRED_NODE_MAJOR) {
	process.stderr.write(
		`agent-scheduler daemon requires Node.js >= ${REQUIRED_NODE_MAJOR}; current version is v${currentVersion}.\n`,
	);
	process.exitCode = 1;
} else {
	const { register } = await import('node:module');
	register(new URL('./typescript-loader.mjs', import.meta.url));
	await import('./src/main.ts');
}
