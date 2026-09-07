import { createContainer } from './boot/container.ts';
import { registerRuntimeGuards } from './boot/guards.ts';
import { runBootSelfCheck } from './boot/self-check.ts';
import { takeBootSnapshot } from './boot/snapshot.ts';

export async function main(): Promise<never> {
	const snapshot = takeBootSnapshot();
	const container = createContainer(snapshot);

	registerRuntimeGuards({
		pid: snapshot.pid,
		writeRunLog: snapshot.writeRunLog,
		fatalExit: () => process.exit(1),
	});

	const bootResult = runBootSelfCheck(container);
	if (!bootResult.ok) {
		for (const line of bootResult.failure.lines) {
			container.writeRunLog(line);
		}
		process.exit(bootResult.failure.exitCode);
	}

	const { config } = bootResult;

	let server: ReturnType<typeof container.createHttpServer>;
	try {
		const database = container.openDatabase(container.databasePath());
		container.runMigrations(database);
		server = container.createHttpServer({ database, config });
		await server.listen({ host: config.bind, port: config.port });
		container.writeRunLog(
			`daemon ready pid=${snapshot.pid} bind=${config.bind} port=${config.port}`,
		);
	} catch (error) {
		container.writeRunLog(
			`[startup-failure] ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
	return new Promise<never>(() => {
		setInterval(() => {
			// keep the event loop alive
		}, 2_147_483_647);
	});
}

function handleStartupFailure(error: unknown): never {
	const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	process.stderr.write(`[startupFailure] ${summary}\n`);
	process.exit(1);
}

void main().catch(handleStartupFailure);
