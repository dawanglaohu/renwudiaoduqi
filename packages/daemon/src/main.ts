import { createContainer } from './boot/container.ts';
import { registerRuntimeGuards } from './boot/guards.ts';
import { runBootSelfCheck } from './boot/self-check.ts';
import { takeBootSnapshot } from './boot/snapshot.ts';

export async function main(): Promise<never> {
	const container = createContainer(takeBootSnapshot());
	registerRuntimeGuards({
		pid: container.pid,
		writeRunLog: container.writeRunLog,
		fatalExit: () => process.exit(1),
	});

	const result = runBootSelfCheck(container);
	if (!result.ok) {
		for (const line of result.failure.lines) {
			container.writeRunLog(line);
		}
		container.writeRunLog(`boot failed at stage ${result.failure.stage}.`);
		process.exit(result.failure.exitCode);
	}

	container.writeRunLog(
		`agent-scheduler daemon boot self-check passed. pid=${container.pid} port=${result.config.port}`,
	);
	return container.stayResident(result.lock);
}

function handleStartupFailure(error: unknown): never {
	const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	process.stderr.write(`[startupFailure] ${summary}\n`);
	process.exit(1);
}

void main().catch(handleStartupFailure);
