// 说明：锁被持有时持有者 pid 已写入锁文件正文。同一 Windows 机器上
// 同一数据目录绝不许两个调度器同时推进同一批次（E-03 原文）。
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export class InstanceLockError extends Error {
	readonly lockFilePath: string;
	readonly existingPid: number | null;

	constructor(lockFilePath: string, existingPid: number | null, cause?: unknown) {
		super(
			existingPid === null
				? `another daemon instance already holds the lock at "${lockFilePath}".`
				: `another daemon instance (pid ${existingPid}) already holds the lock at "${lockFilePath}".`,
		);
		this.name = 'InstanceLockError';
		this.lockFilePath = lockFilePath;
		this.existingPid = existingPid;
		if (cause !== undefined) this.cause = cause;
	}
}

export interface LockHandle {
	readonly pid: number;
	readonly lockFilePath: string;
	release(): void;
}

// E-03：单实例锁，O_EXCL 原子建锁；建成功后写入自身 pid 便于第二实例定位持有者。
// 生命周期只有两种合法状态：不存在 / 活着的持有者负责删除。
export function acquireInstanceLock(lockFilePath: string): LockHandle {
	try {
		const fd = openSync(lockFilePath, 'wx');
		try {
			writeSync(fd, `${process.pid}\n`);
		} finally {
			closeSync(fd);
		}
		let released = false;
		return {
			pid: process.pid,
			lockFilePath,
			release() {
				if (released) return;
				released = true;
				releaseLockFile(lockFilePath);
			},
		};
	} catch (err) {
		if (isFileExistsError(err)) {
			throw new InstanceLockError(lockFilePath, readPidFromLock(lockFilePath), err);
		}
		throw err;
	}
}

export function readPidFromLock(lockFilePath: string): number | null {
	try {
		const text = readFileSync(lockFilePath, 'utf8').trim();
		const pid = Number.parseInt(text, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isFileExistsError(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

function releaseLockFile(lockFilePath: string): void {
	try {
		unlinkSync(lockFilePath);
	} catch (err) {
		// 仅忽略「文件不存在」——清理权转给已经删它的那侧，不算失败。
		if (!isEnoent(err)) throw err;
	}
}

function isEnoent(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
