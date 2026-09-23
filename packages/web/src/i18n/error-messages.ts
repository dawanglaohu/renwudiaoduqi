/**
 * packages/web/src/i18n/error-messages.ts
 *
 * 错误码中文映射字典与规格化工具（06 节错误体系、07 节架构、10 节接口约定）
 *
 * 规范依据：
 * - 只有 web 的 src/i18n/error-messages.ts 转中文文案（缺键回落显示原始 code）
 * - daemon 的 message 恒为英文开发者短句，中文用户文案只在前端
 * - 前端禁止按 HTTP 状态码分支，一律按 error.code
 * - 英文 message 只出现在可展开的「技术详情」里并附一键复制 requestId
 */

import type { ErrorCode } from '../../../shared/src/errors/codes.ts';

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
	E_VALIDATION: '输入参数不合规，请检查后重试',
	E_UNAUTHORIZED: '未登录或设备授权已失效，请重新配对',
	E_PAIRING_CODE_INVALID: '配对码错误、已失效或已被使用',
	E_FORBIDDEN: '当前设备无权执行该操作',
	E_NOT_FOUND: '请求的资源不存在或已被移除',
	E_RUN_ALREADY_EXISTS: '任务已在运行中，绝不产生重复运行',
	E_PATH_CLASH_QUEUED: '与当前在途运行存在文件冲突，已自动进入队列等待',
	E_REPLAY_WINDOW_EXPIRED: '实时事件流断开过久，已切换为全量同步',
	E_DOC_SOURCE_UNREADABLE: '项目文档解析或版本校验失败，派发已冻结',
	E_DOC_CONTRACT_PENDING: '任务契约尚未复核或已失效，禁止新派发',
	E_TASK_REMOVED_FROM_DOC: '该任务在新版本开发文档中已被移除',
	E_SNAPSHOT_STALE: '文档快照已变更，重跑请到桌面端处理',
	E_UPSTREAM_BASE_MISSING: '下游任务缺失上游产出基底，拒绝派发',
	E_AGENT_UNAVAILABLE: '原 Agent 不在线或路径无效，禁止重跑',
	E_AGENT_VERSION_UNRECOGNIZED: 'Agent 版本指纹不匹配已知规范',
	E_AGENT_BUSY: '该 Agent 并发已达上限，请稍候',
	E_RATE_LIMITED: '请求过于频繁，请稍候再试',
	E_MODEL_INVALID: '模型名称无效或已被服务端拒绝',
	E_MESSAGE_UNDELIVERED: '通信管道已断开，消息无法送达',
	E_CAPABILITY_UNSUPPORTED: '该 Agent 不具备所需能力',
	E_WORKSPACE_UNAVAILABLE: '工作树创建失败，已释放执行槽位',
	E_NOT_A_GIT_REPO: '目标工作区不是有效的 Git 仓库',
	E_AGENT_STARTUP_TIMEOUT: 'Agent 进程启动超时',
	E_AGENT_EXEC_NOT_FOUND: '未找到 Agent 可执行文件',
	E_AGENT_EXEC_NOT_EXECUTABLE: 'Agent 可执行文件缺少执行权限',
	E_AGENT_EXEC_INVALID_TARGET: '可执行目标格式无效或链接成环',
	E_LOG_FILE_MISSING: '日志文件已被清理或丢失',
	E_DB_BUSY: '数据库正忙，请稍候重试',
	E_TX_NESTED: '数据库事务异常',
	E_DISK_FULL: '存储空间已满，已停止新派发',
	E_PLATFORM_UNSUPPORTED: '当前操作系统平台不受支持',
	E_AUTOSTART_UNSUPPORTED: '系统不支持开机自启机制',
	E_AUTOSTART_REGISTER_DENIED: '注册自启动项被系统拒绝',
	E_AUTOSTART_UNREGISTER_DENIED: '移除自启动项被系统拒绝',
	E_DATA_DIR_UNRESOLVABLE: '无法解析有效的数据存储目录',
	E_INVALID_STATE_TRANSITION: '非法状态机迁移请求',
	E_GATE_ALREADY_DECIDED: '人工闸门已被裁定，请勿重复操作',
	E_BATCH_NOT_WRAPPABLE: '当前批次尚不满足收口条件',
	E_WRAPUP_ROUND_LIMIT: '收口轮次已达上限，需人工确认',
	E_FIX_RUN_IN_FLIGHT: '已有修复运行在途中，无法执行该操作',
	E_SESSION_ARCHIVED: '目标会话已归档，不可继续操作',
	E_PIPELINE_STAGE_DISABLED: '当前流水线阶段已停用',
	E_AGENT_LOGIN_PROBE_FAILED: 'Agent 登录态探测异常',
	E_LOG_PURGED: '历史日志已按保留策略被清理',
	E_DEVICE_REVOKED: '当前设备已被注销',
	E_NETWORK: '网络连接异常，请检查调度服务是否在线',
	E_TIMEOUT: '请求超时，请稍后重试',
	E_SHELL_UNAVAILABLE: '宿主外壳环境能力不可用',
	E_INTERNAL: '调度服务发生未预期的内部错误',
});

/**
 * 将错误码翻译为中文文案（缺键回落显示原始 code）。
 */
export function getErrorMessage(code: string | undefined | null, fallback?: string): string {
	if (!code) {
		return fallback ?? '操作失败';
	}
	const msg = ERROR_MESSAGES[code as ErrorCode];
	if (msg) {
		return msg;
	}
	return fallback ?? code;
}

/**
 * E-04 要求的首屏文案：明确指出「电脑上的调度服务未启动」，而不是「连接超时」或纯网络术语。
 */
export const SERVICE_NOT_RUNNING_TITLE = '电脑上的调度服务未启动' as const;

/**
 * 启动调度服务失败时的规格化中文文案（07 节约定：不直接向用户展示原生 Rust 错误与原始英文）。
 */
export const LAUNCH_SERVICE_FAILED_MESSAGE =
	'启动调度服务失败，请检查安装环境或尝试手动启动' as const;

/**
 * 解析启动调度服务的中文错误文案：已规格化的 ApiError 按 code 查表，其余返回统一中文提示。
 */
export function getLaunchErrorMessage(error?: unknown): string {
	if (
		error &&
		typeof error === 'object' &&
		'code' in error &&
		typeof (error as { code: unknown }).code === 'string'
	) {
		const code = (error as { code: string }).code as ErrorCode;
		const msg = ERROR_MESSAGES[code];
		if (msg) {
			return msg;
		}
	}
	return LAUNCH_SERVICE_FAILED_MESSAGE;
}
