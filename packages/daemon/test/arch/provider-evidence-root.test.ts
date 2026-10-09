import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const source = ts.createSourceFile(
	'provider.test.ts',
	readFileSync(resolve(root, 'e2e/batch-17-real-provider.test.ts'), 'utf8'),
	ts.ScriptTarget.Latest,
	true,
);
const declaration = source.statements
	.filter(ts.isVariableStatement)
	.flatMap((statement) => [...statement.declarationList.declarations])
	.find((item) => ts.isIdentifier(item.name) && item.name.text === 'plan');
if (!declaration?.initializer) throw new Error('Provider E2E evidence root declaration is missing');
const expression = ts
	.createPrinter()
	.printNode(ts.EmitHint.Expression, declaration.initializer, source);

// Evaluate the suite's actual path expression without booting a provider or writing evidence.
function evidenceRoot(override?: string): string {
	return runInNewContext(expression, {
		root,
		resolve,
		process: { env: { R17_EVIDENCE_ROOT: override } },
	});
}

describe('production provider E2E evidence routing', () => {
	it('uses the caller evidence root for a batch closeout', () => {
		const batchRoot = resolve(root, '../.codex-plans/agent-scheduler-batch-17');
		expect(evidenceRoot(batchRoot)).toBe(batchRoot);
	});
	it('preserves the original task root when no override is supplied', () => {
		expect(evidenceRoot()).toBe(resolve(root, '../.codex-plans/agent-scheduler-r17-t73118308'));
	});
});
