import { EnvFormatError, parsePort } from './boot/env-port.ts';
import { printToStderr, registerRuntimeGuards } from './boot/guards.ts';
import { InstanceLockError, type LockHandle, acquireInstanceLock } from './boot/lock.ts';
import { checkNodeVersion } from './boot/node-check.ts';
import { resolveLockFilePath } from './boot/paths.ts';

export interface BootFailure {
	readonly stage:
		| 'node-version' // E-139 Node 版本过低
		| 'env' // 环境变量格式非法（当前仅 AGSCHED_PORT）
		| 'single-instance'; // E-03 已有一个 daemon 在场
	readonly exitCode: number;
	readonly lines: string[];
}

export type BootResult =
	| { readonly ok: true; readonly lock: LockHandle }
	| { readonly ok: false; readonly failure: BootFailure };

// 跑启动序列，可在单元测试里直接调（不 process.exit）。
// 顺序严格：版本 → 环境变量 → 锁。锁必须建在路径已解析之后。
export function runBootSelfCheck(): BootResult {
	// 1. E-139：Node 版本过低即退出。自检不降级、不半残。
	const versionError = checkNodeVersion(process.version);
	if (versionError !== null) {
		return fail(1, 'node-version', [
			versionError.message,
			`Required: Node.js >= ${versionError.requiredMajor}.0.0`,
			`Current : ${process.version}`,
		]);
	}

	// 2. 环境变量格式非法必须报错退出，不许静默回落（AGSCHED_PORT=abc）。
	let lockFilePath: string;
	try {
		const port = parsePort(process.env.AGSCHED_PORT);
		lockFilePath = resolveLockFilePath(port);
	} catch (err) {
		if (err instanceof EnvFormatError) {
			return fail(1, 'env', [
				`${err.varName} has invalid format: "${err.actual}". Expected ${err.expected}.`,
				'Fix the environment variable and restart the daemon. Default is not applied here.',
			]);
		}
		throw err;
	}

	// 3. E-03：第二个实例必须拒绝启动并把请求让给已有实例。
	try {
		const lock = acquireInstanceLock(lockFilePath);
		return { ok: true, lock };
	} catch (err) {
		if (err instanceof InstanceLockError) {
			const pidPart =
				err.existingPid === null
					? 'existing instance pid: unknown (lock file has no readable pid)'
					: `existing instance pid: ${err.existingPid}`;
			return fail(1, 'single-instance', [
				err.message,
				`lock file: ${err.lockFilePath}`,
				pidPart,
				'This daemon refuses to start; hand the request to the already-running instance.',
			]);
		}
		throw err;
	}
}

function fail(exitCode: number, stage: BootFailure['stage'], lines: string[]): BootResult {
	return { ok: false, failure: { exitCode, stage, lines } };
}

// 全仓唯一直接调 process.exit 与 SIGINT 的文件。架构定死的归属（见 08-后端架构）。
export function main(): void {
	// E-213 的第一道兜底：先把全局钩子装上，再跑任何一步。
	registerRuntimeGuards();

	const result = runBootSelfCheck();
	if (!result.ok) {
		for (const line of result.failure.lines) printToStderr(line);
		process.stderr.write(`boot failed at stage ${result.failure.stage}.\n`);
		process.exit(result.failure.exitCode);
	}

	// 至此 daemon 进程独占，可以交棒给后续 —— 数据目录 / db / fastify / jobs / listen 由后续任务挂进来。
	printToStderr(`agent-scheduler daemon boot self-check passed. pid=${process.pid}`);

	// 骨架阶段不启动任何长任务：抢到锁立即释放并正常退出。
	result.lock.release();
}

main();
