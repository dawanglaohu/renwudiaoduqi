/**
 * packages/web/src/features/run-deck/run-deck-container.tsx
 *
 * 运行甲板多流监看与手机单栏容器组件（M9-T9, M9-T12 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构）：
 * - features 是容器层，每域固定 use-<域>.ts + <域>-container.tsx 两类文件
 * - 容器里只许写 grid/flex/gap，禁止写颜色字号圆角
 * - 界面不含业务判定，所有字段直接传递至视图
 */

import { RunDeckView } from './run-deck-view.tsx';
import type { RunDeckProps } from './types.ts';
import { useRunDeck } from './use-run-deck.ts';

export function RunDeckContainer(props: RunDeckProps) {
	const deckState = useRunDeck(props);

	return (
		<div className="flex flex-col h-full w-full gap-2">
			<RunDeckView
				{...deckState}
				lanes={props.lanes}
				batches={props.batches}
				onSelectTask={props.onSelectTask}
				toolbarSlot={props.toolbarSlot}
				className={props.className}
			/>
		</div>
	);
}
