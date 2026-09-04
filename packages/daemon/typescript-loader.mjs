import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function load(url, context, nextLoad) {
	if (!url.endsWith('.ts')) {
		return nextLoad(url, context);
	}

	const fileName = fileURLToPath(url);
	const source = await readFile(fileName, 'utf8');
	const result = ts.transpileModule(source, {
		fileName,
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			verbatimModuleSyntax: true,
		},
	});

	return {
		format: 'module',
		shortCircuit: true,
		source: result.outputText,
	};
}
