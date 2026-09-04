import type { RuntimeLogWriter } from './snapshot.ts';

const MAX_UNCAUGHT_SUMMARY_LENGTH = 200;

export interface RuntimeGuardDependencies {
	readonly pid: number;
	readonly writeRunLog: RuntimeLogWriter;
	readonly fatalExit: () => void;
}

export interface RuntimeGuardHandlers {
	readonly unhandledRejection: (reason: unknown) => void;
	readonly uncaughtException: (error: unknown) => void;
}

export function createRuntimeGuardHandlers(
	dependencies: RuntimeGuardDependencies,
): RuntimeGuardHandlers {
	return {
		unhandledRejection(reason: unknown): void {
			dependencies.writeRunLog(
				`[unhandledRejection] ${summarize(reason)} in process ${dependencies.pid}. Unawaited promises must be written as explicit \`void fn()\` fire-and-forget. See E-213.`,
			);
		},
		uncaughtException(error: unknown): void {
			try {
				dependencies.writeRunLog(
					`[uncaughtException] ${summarize(error)} in process ${dependencies.pid}.`,
				);
			} finally {
				dependencies.fatalExit();
			}
		},
	};
}

export function registerRuntimeGuards(dependencies: RuntimeGuardDependencies): void {
	const handlers = createRuntimeGuardHandlers(dependencies);
	process.on('unhandledRejection', handlers.unhandledRejection);
	process.on('uncaughtException', handlers.uncaughtException);
}

function summarize(error: unknown): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.length > MAX_UNCAUGHT_SUMMARY_LENGTH
		? `${text.slice(0, MAX_UNCAUGHT_SUMMARY_LENGTH)}…`
		: text;
}
