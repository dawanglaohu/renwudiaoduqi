// 启动序列的最早能承载日志的阶段。E-213 要求注册 process.on('unhandledRejection')
// 兜底 E-213，顺路记 process.on('uncaughtException')；这两个钩子必须在任何业务代码之前装上。
// process.platform 全仓只许 boot 阶段与 platform 模块直读（M1-T3），自检时 boot 是入口，先允许。

const MAX_UNCAUGHT_SUMMARY_LENGTH = 200;

export function registerRuntimeGuards(): void {
	process.on('unhandledRejection', (reason: unknown) => {
		// 全局兜底，只记不拦。此时进程语义已不干净，但不 kill——任务在记录在别的路径。
		printToStderr(
			`[unhandledRejection] ${summarize(reason)} in process ${process.pid}. Unawaited promises must be written as explicit \`void fn()\` fire-and-forget. See E-213.`,
		);
	});

	process.on('uncaughtException', (err: unknown) => {
		printToStderr(`[uncaughtException] ${summarize(err)} in process ${process.pid}.`);
	});
}

function summarize(err: unknown): string {
	if (err instanceof Error) {
		const head = `${err.name}: ${err.message}`;
		return head.length > MAX_UNCAUGHT_SUMMARY_LENGTH
			? `${head.slice(0, MAX_UNCAUGHT_SUMMARY_LENGTH)}…`
			: head;
	}
	const text = String(err);
	return text.length > MAX_UNCAUGHT_SUMMARY_LENGTH
		? `${text.slice(0, MAX_UNCAUGHT_SUMMARY_LENGTH)}…`
		: text;
}

export function printToStderr(line: string): void {
	// 只在这一个文件允许 process.stderr 直写；上层日志组件到位前它是「运行日志」。
	process.stderr.write(`${line}\n`);
}
