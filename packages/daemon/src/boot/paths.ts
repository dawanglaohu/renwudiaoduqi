import { mkdirSync } from 'node:fs';
// 锁文件放哪：必须先知道在那个数据目录；数据目录由 M1-T2/M1-T3（platform/config）接管。
// 本骨架阶段按规约内嵌一个最小实现：%APPDATA%\agent-scheduler（回退用户主目录），文件名 daemon.lock。
// 建锁前负责 mkdir，这正是 E-03 与路径规范化（M1-T3）的交界处——此处保证目录存在即可。
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCK_FILE_NAME = 'daemon.lock';

export function defaultDataDir(): string {
	// 平台差异收口未交付前（M1-T3 前），boot 允许的最小直接依赖。
	const appData = process.env.APPDATA;
	if (typeof appData === 'string' && appData.length > 0) {
		return join(appData, 'agent-scheduler');
	}
	return join(homedir(), '.agent-scheduler');
}

export function resolveLockFilePath(_port: number): string {
	const dir = defaultDataDir();
	// 目录不存在要建出来；权限/磁盘错误直接抛到上层，不静默。
	mkdirSync(dir, { recursive: true });
	return join(dir, LOCK_FILE_NAME);
}
