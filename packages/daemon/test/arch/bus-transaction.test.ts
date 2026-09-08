import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const sourceRoot = join(daemonRoot, 'src');

interface AstViolation {
	readonly file: string;
	readonly line: number;
	readonly message: string;
}

function detectBusPublishInTransaction(sourceText: string, filePath = 'test.ts'): AstViolation[] {
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const violations: AstViolation[] = [];

	function isTransactionMethod(name: string): boolean {
		return name === 'run' || name === 'transaction';
	}

	function isPublishMethod(name: string): boolean {
		return name === 'publish';
	}

	function checkCallExpression(node: ts.CallExpression, insideTransaction: boolean) {
		const expr = node.expression;
		let methodName = '';

		if (ts.isPropertyAccessExpression(expr)) {
			methodName = expr.name.text;
		}

		if (insideTransaction && isPublishMethod(methodName)) {
			const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
			violations.push({
				file: filePath,
				line: pos.line + 1,
				message: `bus.publish called inside transaction callback: ${node.getText(sourceFile)}`,
			});
		}

		const triggersTransaction = isTransactionMethod(methodName);

		// Recurse into the expression (e.g. database.transaction(...)())
		checkNode(expr, insideTransaction);

		for (const arg of node.arguments) {
			if (triggersTransaction && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
				checkNode(arg.body, true);
			} else {
				checkNode(arg, insideTransaction);
			}
		}
	}

	function checkNode(node: ts.Node, insideTransaction: boolean) {
		if (ts.isCallExpression(node)) {
			checkCallExpression(node, insideTransaction);
			return;
		}

		ts.forEachChild(node, (child) => checkNode(child, insideTransaction));
	}

	checkNode(sourceFile, false);
	return violations;
}

describe('M2-T4 Architecture: bus.publish outside transaction callbacks (Acceptance Criterion 3)', () => {
	it('asserts that no production source file calls bus.publish inside a transaction callback', () => {
		const allViolations: AstViolation[] = [];

		for (const file of listTypeScriptFiles(sourceRoot)) {
			const content = readFileSync(file, 'utf8');
			const relPath = relative(repositoryRoot, file).replaceAll('\\', '/');
			const violations = detectBusPublishInTransaction(content, relPath);
			allViolations.push(...violations);
		}

		expect(allViolations).toEqual([]);
	});

	it('detects violations when bus.publish appears inside unitOfWork.run', () => {
		const badCode = `
			function test(unitOfWork: any, bus: any, event: any) {
				unitOfWork.run(() => {
					doSomethingInDb();
					bus.publish(event);
				});
			}
		`;
		const violations = detectBusPublishInTransaction(badCode, 'sample-bad.ts');
		expect(violations).toHaveLength(1);
		expect(violations[0]?.message).toContain('bus.publish called inside transaction callback');
	});

	it('detects violations when bus.publish appears inside database.transaction', () => {
		const badCode = `
			function test(database: any, bus: any, event: any) {
				database.transaction(() => {
					bus.publish(event);
				})();
			}
		`;
		const violations = detectBusPublishInTransaction(badCode, 'sample-tx.ts');
		expect(violations).toHaveLength(1);
	});

	it('allows correct patterns where bus.publish is called after the transaction commits', () => {
		const goodCode = `
			function test(unitOfWork: any, bus: any, event: any) {
				const events = unitOfWork.run(() => {
					doSomethingInDb();
					return [event];
				});
				for (const e of events) {
					bus.publish(e);
				}
			}
		`;
		const violations = detectBusPublishInTransaction(goodCode, 'sample-good.ts');
		expect(violations).toEqual([]);
	});
});

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
		else if (extname(entry.name) === '.ts') files.push(path);
	}
	return files;
}
