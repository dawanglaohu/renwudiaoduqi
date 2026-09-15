import type { AgentFieldKey } from '../../components/field-layers-row.tsx';

// features 侧只保留本域自己的常量；展示层的 props 契约与尺寸常量
// 分居 components/ 各自文件，避免 components 反向 import features（07 节分层）。

export const FIELD_LABELS: Readonly<Record<AgentFieldKey, string>> = Object.freeze({
	monogram: '两字符短码',
	execPath: '可执行路径',
	defaultModel: '默认模型',
	maxConcurrency: '最大并发数',
	permissionTier: '权限档',
});
