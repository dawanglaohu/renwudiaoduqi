import type { AgentFieldKey } from '../../components/field-layers-row.tsx';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';

// features 侧只保留本域自己的常量；展示层的 props 契约与尺寸常量
// 分居 components/ 各自文件，避免 components 反向 import features（07 节分层）。

export const FIELD_LABELS: Readonly<Record<AgentFieldKey, string>> = Object.freeze({
	monogram: UI_STRINGS.agentCard.monogramLabel,
	execPath: UI_STRINGS.agentCard.execPathLabel,
	defaultModel: UI_STRINGS.agentCard.defaultModelLabel,
	maxConcurrency: UI_STRINGS.agentCard.concurrencyLabel,
	permissionTier: UI_STRINGS.agentCard.permissionLabel,
});
