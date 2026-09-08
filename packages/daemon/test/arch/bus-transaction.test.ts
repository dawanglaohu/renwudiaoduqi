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

	// Index local function declarations and variable function initializers
	const localFunctions = new Map<
		string,
		ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
	>();

	function indexDefinitions(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			localFunctions.set(node.name.text, node);
		} else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
				localFunctions.set(node.name.text, node.initializer);
			}
		}
		ts.forEachChild(node, indexDefinitions);
	}
	indexDefinitions(sourceFile);

	function isTransactionObject(expr: ts.Expression): boolean {
		const text = expr.getText(sourceFile).toLowerCase();
		return (
			text.includes('unitofwork') ||
			text.includes('uow') ||
			text.includes('database') ||
			text.includes('db') ||
			text.includes('transaction')
		);
	}

	function isPublishCall(node: ts.CallExpression): boolean {
		if (ts.isPropertyAccessExpression(node.expression)) {
			const methodName = node.expression.name.text;
			if (methodName === 'publish') {
				const objText = node.expression.expression.getText(sourceFile).toLowerCase();
				return objText.includes('bus') || objText.includes('event');
			}
		}
		return false;
	}

	function scanBodyForPublish(bodyNode: ts.Node, visited = new Set<ts.Node>()): void {
		if (visited.has(bodyNode)) return;
		visited.add(bodyNode);

		if (ts.isCallExpression(bodyNode)) {
			if (isPublishCall(bodyNode)) {
				const pos = sourceFile.getLineAndCharacterOfPosition(bodyNode.getStart());
				const line = pos.line + 1;
				if (!violations.some((v) => v.file === filePath && v.line === line)) {
					violations.push({
						file: filePath,
						line,
						message: `bus.publish called inside transaction callback: ${bodyNode.getText(sourceFile)}`,
					});
				}
			}

			// If it calls a local helper function, trace into it
			if (ts.isIdentifier(bodyNode.expression)) {
				const helper = localFunctions.get(bodyNode.expression.text);
				if (helper) {
					const helperBody = helper.body;
					if (helperBody) {
						scanBodyForPublish(helperBody, visited);
					}
				}
			}
		}

		ts.forEachChild(bodyNode, (child) => scanBodyForPublish(child, visited));
	}

	function inspectTransactionArg(arg: ts.Expression): void {
		if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
			scanBodyForPublish(arg.body);
		} else if (ts.isIdentifier(arg)) {
			const target = localFunctions.get(arg.text);
			if (target) {
				const targetBody = target.body;
				if (targetBody) {
					scanBodyForPublish(targetBody);
				}
			}
		}
	}

	function visit(node: ts.Node) {
		if (ts.isCallExpression(node)) {
			const expr = node.expression;

			// Direct or chained transaction method
			if (ts.isPropertyAccessExpression(expr)) {
				const methodName = expr.name.text;
				if (
					(methodName === 'run' || methodName === 'transaction') &&
					isTransactionObject(expr.expression)
				) {
					for (const arg of node.arguments) {
						inspectTransactionArg(arg);
					}
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
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

	it('detects violations when bus.publish appears inside unitOfWork.run inline callback', () => {
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

	it('detects violations when bus.publish is passed via a named function or variable callback', () => {
		const badCodeWithVariable = `
			function test(unitOfWork: any, bus: any, event: any) {
				const txCallback = () => {
					bus.publish(event);
				};
				unitOfWork.run(txCallback);
			}
		`;
		const violations1 = detectBusPublishInTransaction(badCodeWithVariable, 'sample-var.ts');
		expect(violations1).toHaveLength(1);

		const badCodeWithNamedFunction = `
			function performTx(bus: any, event: any) {
				bus.publish(event);
			}
			function test(unitOfWork: any, bus: any, event: any) {
				unitOfWork.run(performTx);
			}
		`;
		const violations2 = detectBusPublishInTransaction(badCodeWithNamedFunction, 'sample-named.ts');
		expect(violations2).toHaveLength(1);
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

	it('does NOT false-alarm on unrelated objects that have a .run method', () => {
		const nonTxCode = `
			function test(taskRunner: any, bus: any, event: any) {
				taskRunner.run(() => {
					bus.publish(event);
				});
			}
		`;
		const violations = detectBusPublishInTransaction(nonTxCode, 'sample-runner.ts');
		expect(violations).toEqual([]);
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
