import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packagesRoot = join(repositoryRoot, 'packages');
const daemonRoot = join(packagesRoot, 'daemon');

describe('source contracts', () => {
	it('routes every daemon startup script through the Node-compatible bootstrap', () => {
		const manifest = JSON.parse(readFileSync(join(daemonRoot, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		const startupScripts = [manifest.scripts.dev, manifest.scripts.start];

		expect(startupScripts).toEqual(['node bootstrap.mjs', 'node bootstrap.mjs']);
	});

	it('keeps direct environment reads at the approved boundaries', () => {
		const matches = sourceFiles()
			.filter((file) => readFileSync(file, 'utf8').includes('process.env'))
			.map(repositoryPath);
		const approvedPaths = ['packages/daemon/src/config/env.ts', 'packages/daemon/src/proc/env.ts'];

		expect(matches).toContain('packages/daemon/src/config/env.ts');
		expect(matches.filter((path) => !approvedPaths.includes(path))).toEqual([]);
	});

	it('does not define Error subclasses outside the AppError hierarchy', () => {
		const matches = sourceFiles()
			.filter((file) => /extends\s+Error\b/.test(readFileSync(file, 'utf8')))
			.map(repositoryPath);
		expect(matches.filter((path) => path !== 'packages/daemon/src/errors/app-error.ts')).toEqual(
			[],
		);
	});

	it('injects fatal process exit and marks the async entry as fire-and-forget', () => {
		const mainSource = readFileSync(join(daemonRoot, 'src/main.ts'), 'utf8');
		expect(mainSource).toContain('fatalExit: () => process.exit(1)');
		expect(mainSource).toContain('void main().catch(handleStartupFailure)');
	});

	it('marks every unhandled Promise call statement with void', () => {
		const files = typescriptFiles(packagesRoot);
		const program = ts.createProgram(files, {
			allowImportingTsExtensions: true,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			noEmit: true,
			strict: true,
			target: ts.ScriptTarget.ES2022,
			types: ['node'],
		});
		const checker = program.getTypeChecker();
		const violations: string[] = [];

		for (const sourceFile of program.getSourceFiles()) {
			if (!sourceFile.fileName.startsWith(packagesRoot)) continue;
			visitPromiseStatements(sourceFile, checker, violations);
		}

		expect(violations).toEqual([]);
	});

	it('ensures adapters do not import node:os and avoid synchronous filesystem operations', () => {
		const adapterFiles = sourceFiles().filter((file) =>
			repositoryPath(file).includes('/src/adapters/'),
		);
		expect(adapterFiles.length).toBeGreaterThan(0);
		for (const file of adapterFiles) {
			const content = readFileSync(file, 'utf8');
			expect(content).not.toMatch(/from ['"]node:os['"]/);
			expect(content).not.toMatch(/from ['"]os['"]/);
			expect(content).not.toMatch(/\b(?:readFileSync|statSync|existsSync|writeFileSync)\b/);
		}
	});
});

function visitPromiseStatements(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	violations: string[],
): void {
	function visit(node: ts.Node): void {
		if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
			const type = checker.getTypeAtLocation(node.expression);
			if (checker.getPropertyOfType(type, 'then') !== undefined) {
				const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
				violations.push(`${repositoryPath(sourceFile.fileName)}:${position.line + 1}`);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
}

function sourceFiles(): string[] {
	return typescriptFiles(packagesRoot).filter((file) => repositoryPath(file).includes('/src/'));
}

/**
 * Build outputs are products, not sources: the desktop shell's `src-tauri/gen` and
 * `src-tauri/target` carry a full copy of the daemon (the shipped daemon distribution),
 * and scanning that copy would report the approved boundaries a second time.
 */
const BUILD_OUTPUT_DIRECTORIES = new Set(['node_modules', 'dist', 'target', 'gen']);

function typescriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (BUILD_OUTPUT_DIRECTORIES.has(entry.name)) continue;
			files.push(...typescriptFiles(path));
		} else if (['.cts', '.mts', '.ts', '.tsx'].includes(extname(entry.name))) {
			files.push(path);
		}
	}
	return files;
}

function repositoryPath(path: string): string {
	return relative(repositoryRoot, path).replaceAll('\\', '/');
}
