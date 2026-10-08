import { writeFileSync } from 'node:fs';
import { parseDocsDataContent } from '../../src/service/docs.ts';

export function writeTaskDocsData(
	path: string,
	id: string,
	hash: string,
	implPrompt = 'Implement',
): string {
	return writeTasksDocsData(path, [{ id, hash, implPrompt }]);
}

export function writeTasksDocsData(
	path: string,
	tasks: readonly { id: string; hash: string; implPrompt?: string; deps?: readonly string[] }[],
): string {
	const paths = ['src/'];
	const content = `window.DOCS = ${JSON.stringify({
		schemaVersion: 1,
		project: 'Dispatch integration fixture',
		data: {
			tasks: tasks.map(({ id, deps }) => ({
				id,
				title: 'Task',
				module: 'M1',
				deps: deps ?? [],
				accept: 'Works',
			})),
		},
		handoff: {
			version: '1.1.0',
			schemaVersion: 1,
			contracts: Object.fromEntries(
				tasks.map(({ id, hash }) => [id, { hash, effectivePaths: paths }]),
			),
			readiness: Object.fromEntries(
				tasks.map(({ id, hash }) => [id, { ready: true, reasons: [], contractHash: hash }]),
			),
			effectivePaths: Object.fromEntries(tasks.map(({ id }) => [id, paths])),
		},
		dispatch: Object.fromEntries(
			tasks.map(({ id, hash, implPrompt }) => [
				id,
				{ contractHash: hash, implementation: implPrompt ?? 'Implement', review: 'Review' },
			]),
		),
	})};`;
	writeFileSync(path, content);
	return parseDocsDataContent(content).contentFingerprint;
}
