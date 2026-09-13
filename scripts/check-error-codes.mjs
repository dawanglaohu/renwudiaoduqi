import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const docPath = path.join(projectRoot, 'docs/Agent任务调度器-开发文档/02-设计/10-接口约定.md');
const codePath = path.join(projectRoot, 'packages/shared/src/errors/codes.ts');

if (!fs.existsSync(docPath)) {
	console.error(`[check-error-codes] Error: Documentation file not found at ${docPath}`);
	process.exit(1);
}
if (!fs.existsSync(codePath)) {
	console.error(`[check-error-codes] Error: codes.ts not found at ${codePath}`);
	process.exit(1);
}

const docContent = fs.readFileSync(docPath, 'utf8');
const codeContent = fs.readFileSync(codePath, 'utf8');

// 1. Extract error codes table from documentation (Source of Truth)
const errorTableSection = docContent.split('## 错误码表')[1]?.split('## ')[0];
if (!errorTableSection) {
	console.error('[check-error-codes] Error: "## 错误码表" section not found in documentation.');
	process.exit(1);
}

const docCodes = new Map();
const docRows = errorTableSection.split('\n');
const rowRegex =
	/\|\s*`?(E_[A-Z0-9_]+)`?\s*\|\s*(server|client)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/;

for (const line of docRows) {
	const trimmed = line.trim();
	// Skip only the table header and the separator row; a data row's description may legitimately
	// mention 'HTTP' (e.g. E_AGENT_LOGIN_PROBE_FAILED), so it must not be used as a header marker.
	if (
		!trimmed.startsWith('|') ||
		/^\|\s*code\s*\|/i.test(trimmed) ||
		/^\|\s*:?-{3,}/.test(trimmed)
	) {
		continue;
	}
	const match = rowRegex.exec(trimmed);
	if (match) {
		const [, code, origin, httpRaw, retryRaw, desc] = match;
		const httpStr = httpRaw.trim();
		const defaultHttpStatus =
			httpStr === '—' || httpStr === '-' || httpStr === 'null'
				? null
				: Number.parseInt(httpStr, 10);
		const retryable = retryRaw.trim() === '是';
		docCodes.set(code, {
			code,
			origin,
			defaultHttpStatus,
			retryable,
			description: desc.trim(),
		});
	}
}

// 2. Extract error codes from code (Projection)
const codeCodes = new Map();
const entryRegex = /(E_[A-Z0-9_]+)\s*:\s*\{([^}]+)\}/g;
let entryMatch = null;

while (true) {
	entryMatch = entryRegex.exec(codeContent);
	if (!entryMatch) break;
	const [, code, body] = entryMatch;
	const httpMatch = body.match(/defaultHttpStatus\s*:\s*(null|\d+)/);
	const retryMatch = body.match(/retryable\s*:\s*(true|false)/);
	const originMatch = body.match(/origin\s*:\s*['"](server|client)['"]/);

	if (!originMatch || !retryMatch || !httpMatch) {
		console.error(`[check-error-codes] Failed to parse entry in codes.ts: ${code}`);
		process.exit(1);
	}

	codeCodes.set(code, {
		code,
		origin: originMatch[1],
		defaultHttpStatus: httpMatch[1] === 'null' ? null : Number.parseInt(httpMatch[1], 10),
		retryable: retryMatch[1] === 'true',
	});
}

// 3. Compare: Documentation is source, code is projection
const errors = [];

if (docCodes.size === 0) {
	errors.push('No error codes parsed from documentation.');
}
if (codeCodes.size === 0) {
	errors.push('No error codes parsed from codes.ts.');
}

// Check for missing or mismatched codes in codeCodes
for (const [code, docEntry] of docCodes.entries()) {
	const codeEntry = codeCodes.get(code);
	if (!codeEntry) {
		errors.push(`Missing in codes.ts: ${code} (defined in docs/02-设计/10-接口约定.md)`);
		continue;
	}

	if (codeEntry.origin !== docEntry.origin) {
		errors.push(
			`Mismatch for ${code}.origin: doc='${docEntry.origin}', code='${codeEntry.origin}'`,
		);
	}
	if (codeEntry.defaultHttpStatus !== docEntry.defaultHttpStatus) {
		errors.push(
			`Mismatch for ${code}.defaultHttpStatus: doc=${docEntry.defaultHttpStatus}, code=${codeEntry.defaultHttpStatus}`,
		);
	}
	if (codeEntry.retryable !== docEntry.retryable) {
		errors.push(
			`Mismatch for ${code}.retryable: doc=${docEntry.retryable}, code=${codeEntry.retryable}`,
		);
	}
}

// Check for extraneous codes in codeCodes not in documentation
for (const code of codeCodes.keys()) {
	if (!docCodes.has(code)) {
		errors.push(`Extraneous in codes.ts: ${code} (not declared in docs/02-设计/10-接口约定.md)`);
	}
}

if (errors.length > 0) {
	console.error('[check-error-codes] Error code consistency check FAILED:');
	for (const err of errors) {
		console.error(`  - ${err}`);
	}
	process.exit(1);
}

console.log(
	`[check-error-codes] OK: ${docCodes.size} error codes match perfectly between documentation and codes.ts.`,
);
process.exit(0);
