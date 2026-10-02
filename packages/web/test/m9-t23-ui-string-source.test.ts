import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DISPLAY_FILES = [
	'components/agent-card.tsx',
	'components/assign-panel.tsx',
	'components/pipeline-assignment.tsx',
	'components/model-picker.tsx',
	'components/effort-picker.tsx',
	'ui/grouped-select.tsx',
] as const;

function inspectSource(text: string, file = 'example.tsx') {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const chinese: { line: number; text: string }[] = [];
	const reverseImports: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isTypeNode(node)) return;
		const literalText =
			ts.isJsxText(node) || ts.isStringLiteral(node)
				? node.text.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hex, decimal) => {
						const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
						return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
					})
				: ts.isStringLiteralLike(node) ||
						ts.isTemplateHead(node) ||
						ts.isTemplateMiddle(node) ||
						ts.isTemplateTail(node)
					? node.text
					: '';
		if (
			(ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node) ||
				ts.isJsxText(node)) &&
			/\p{Script=Han}/u.test(literalText)
		) {
			chinese.push({
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				text: node.text,
			});
		}
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			/(?:^|\/)(?:i18n|features)(?:\/|$)/.test(node.moduleSpecifier.text)
		) {
			reverseImports.push(node.moduleSpecifier.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { chinese, reverseImports };
}

describe('M9-T23 Chinese UI source ownership', () => {
	it.each(DISPLAY_FILES)('%s has no runtime Chinese literal', (file) => {
		const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
		expect(inspectSource(text, file).chinese).toEqual([]);
	});

	it.each([
		'const label = "内置默认";',
		'const label = "\\u4f60\\u7684\\u8986\\u76d6";',
		'const view = <button>恢复默认</button>;',
		'const view = <input aria-label="执行 Agent" />;',
		'const view = <input placeholder={"输入名称"} />;',
		'const view = <button>&#x6062;&#22797;默认</button>;',
		'const view = <input aria-label="&#x6267;&#34892; Agent" />;',
		'const label = `会话 ${number}`;',
		'const label = `${number} 分钟前探测`;',
		'const label = `${number} 当前已分配 ${limit}`;',
		'const view = <span>{isFull ? " 已满额" : ""}</span>;',
	])('rejects a newly introduced literal: %s', (text) => {
		expect(inspectSource(text).chinese).toHaveLength(1);
	});

	it('accepts comments, UI_STRINGS and props carrying vendor data', () => {
		const text = `
			// 中文注释不是界面文案
			/** 供应商模型名保持原样 */
			type Example = { kind: '仅类型' };
			const view = <div>{/* 中文 JSX 注释 */}
				<button title={UI_STRINGS.agentCard.noOverrideTitle}>
					{UI_STRINGS.agentCard.restoreDefault}
				</button>
				<input placeholder={labels.customActionPlaceholder} />
				<span>{catalog.models[0].name} {value.vendor} {agent.name}</span>
			</div>;
		`;
		expect(inspectSource(text).chinese).toEqual([]);
	});

	it('keeps generic UI imports independent of business text and features', () => {
		const text = readFileSync(new URL('../src/ui/grouped-select.tsx', import.meta.url), 'utf8');
		expect(inspectSource(text).reverseImports).toEqual([]);
		for (const module of ['../i18n/ui-strings.ts', '../features/settings-agents/example.ts']) {
			expect(inspectSource(`import { labels } from '${module}';`).reverseImports).toEqual([module]);
		}
	});
});
