import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function getAllTsFiles(dir: string): string[] {
	const results: string[] = [];
	const entries = readdirSync(dir);
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			results.push(...getAllTsFiles(fullPath));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			results.push(fullPath);
		}
	}
	return results;
}

/**
 * Finds the enclosing function block around a given character index.
 * Scans backward to locate the function signature and forward to match braces.
 */
function getEnclosingFunctionBody(source: string, callIndex: number): string {
	// Look backward for function keyword or arrow function
	const before = source.slice(0, callIndex);

	// Match common function head patterns:
	// function xxx(...), async (...) =>, const xxx = (...) =>, etc.
	const functionStarts = [before.lastIndexOf('function'), before.lastIndexOf('=>')].filter(
		(idx) => idx !== -1,
	);

	let startIndex = 0;
	if (functionStarts.length > 0) {
		startIndex = Math.max(...functionStarts);
		// If it's an arrow function, look backwards to the parameter list opening or assignment
		const assignmentIndex = before.lastIndexOf('=', startIndex);
		if (assignmentIndex !== -1 && assignmentIndex > startIndex - 150) {
			startIndex = assignmentIndex;
		}
	}

	// Find opening brace '{' after startIndex but before callIndex
	let openBraceIndex = source.indexOf('{', startIndex);
	if (openBraceIndex === -1 || openBraceIndex > callIndex) {
		// Fallback: search backwards for nearest opening brace
		openBraceIndex = before.lastIndexOf('{');
	}

	if (openBraceIndex === -1) {
		return source;
	}

	// Scan forward counting braces until matched
	let depth = 1;
	let i = openBraceIndex + 1;
	while (i < source.length && depth > 0) {
		const char = source[i];
		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
		}
		i++;
	}

	return source.slice(openBraceIndex, i);
}

describe('M6-T10 Architecture: Session Isolation and Guard Assertions', () => {
	const serviceDir = join(__dirname, '../../src/service');
	const migrationsDir = join(__dirname, '../../migrations');

	// =========================================================================
	// AC 6: Static Scan of runsRepo.insert() in src/service/**
	// =========================================================================
	it('AC 6: every runsRepo.insert() in src/service/** has assertSessionRefFree() in the same enclosing function', () => {
		const files = getAllTsFiles(serviceDir);
		expect(files.length).toBeGreaterThan(0);

		const insertCallRegex = /\brunsRepo\.insert\s*\(/g;
		let totalCallSites = 0;

		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			const matches = [...content.matchAll(insertCallRegex)];

			for (const match of matches) {
				totalCallSites++;
				const callIndex = match.index ?? 0;
				const enclosingBody = getEnclosingFunctionBody(content, callIndex);

				const hasAssertCall = enclosingBody.includes('assertSessionRefFree');
				const relativePath = file.replace(/\\/g, '/');

				expect(
					hasAssertCall,
					`Found runsRepo.insert() in ${relativePath} at offset ${callIndex} without assertSessionRefFree() in the same function scope.`,
				).toBe(true);
			}
		}

		// Verify that at least one production call site was discovered and guarded
		expect(totalCallSites).toBeGreaterThan(0);
	});

	// =========================================================================
	// AC 5 & E-303: No UNIQUE constraint on vendor_session_ref
	// =========================================================================
	it('AC 5 & E-303: asserts that no UNIQUE constraint exists on vendor_session_ref in schema migrations or code', () => {
		const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

		for (const file of migrationFiles) {
			const content = readFileSync(join(migrationsDir, file), 'utf8');
			// Assert that vendor_session_ref is not part of any UNIQUE constraint or index
			const hasUniqueVendorRef =
				/UNIQUE\s*\([^)]*vendor_session_ref[^)]*\)/i.test(content) ||
				/CREATE\s+UNIQUE\s+INDEX\s+[^;]*vendor_session_ref/i.test(content);

			expect(
				hasUniqueVendorRef,
				`Migration ${file} must NOT declare a UNIQUE constraint on vendor_session_ref (E-303, AC 5)`,
			).toBe(false);
		}
	});

	// =========================================================================
	// AC 6: Integration Scenarios Verification
	// =========================================================================
	it('AC 6: confirms integration test coverage exists for all 4 scenarios in test/integration/session-archive.test.ts', () => {
		const testFile = join(__dirname, '../integration/session-archive.test.ts');
		const content = readFileSync(testFile, 'utf8');

		expect(content).toContain('归档后投递 409');
		expect(content).toContain('跨任务复用引用 409');
		expect(content).toContain('同任务第 2 轮共享引用 200');
		expect(content).toContain('续接目标已归档 409');
	});
});
