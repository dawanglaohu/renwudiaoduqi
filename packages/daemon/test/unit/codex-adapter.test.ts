import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
	buildCodexLaunchSpec,
	buildLaunchSpec,
} from '../../src/adapters/codex/build-launch-spec.ts';
import {
	CODEX_NATIVE_CAPABILITIES,
	capabilities,
	getCodexCapabilities,
} from '../../src/adapters/codex/capabilities.ts';
import {
	CODEX_VENDOR_EVENT_STRINGS,
	mapCodexEvents,
	mapEvents,
	parseAndMapCodexLine,
} from '../../src/adapters/codex/map-events.ts';
import { readCodexModels, readModels } from '../../src/adapters/codex/read-models.ts';
import { EFFORT_TIERS } from '../../src/domain/effort-tier.ts';
import { PERMISSION_TIERS } from '../../src/domain/permission-tier.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const daemonSrc = resolve(__dirname, '../../src');

describe('M4-T8: codex 原生适配器', () => {
	describe('AC 4 & AC 3: 能力位与破坏性变更切 generic-acp (E-186)', () => {
		it('declares canReply=true for native adapter (codex queue --thread --message)', () => {
			expect(capabilities.canReply).toBe(true);
			expect(CODEX_NATIVE_CAPABILITIES.canReply).toBe(true);
			expect(getCodexCapabilities('native').canReply).toBe(true);
		});

		it('declares hasStreamingEvents=true and canResume=true for native adapter', () => {
			expect(CODEX_NATIVE_CAPABILITIES.hasStreamingEvents).toBe(true);
			expect(CODEX_NATIVE_CAPABILITIES.canResume).toBe(true);
			expect(CODEX_NATIVE_CAPABILITIES.sessionHistory).toBe('full');
		});

		it('E-186: switches adapterKind to generic-acp by changing data alone, narrowing capabilities to canReply=false', () => {
			// Simulating changing a single line of configuration in agents.json data:
			// { "adapterKind": "generic-acp" } vs { "adapterKind": "native" }
			const nativeConfig = { adapterKind: 'native' as const };
			const genericAcpConfig = { adapterKind: 'generic-acp' as const };

			const nativeCaps = getCodexCapabilities(nativeConfig.adapterKind);
			expect(nativeCaps.canReply).toBe(true);
			expect(nativeCaps.canResume).toBe(true);

			const acpCaps = getCodexCapabilities(genericAcpConfig.adapterKind);
			// Under generic-acp, capabilities are narrowed and UI greys out reply button
			expect(acpCaps.canReply).toBe(false);
			expect(acpCaps.canResume).toBe(false);
			expect(acpCaps.sessionHistory).toBe('current-run-only');
			// Streaming events remain available
			expect(acpCaps.hasStreamingEvents).toBe(true);
			expect(Object.isFrozen(acpCaps)).toBe(true);
		});
	});

	describe('AC 1: 主用 app-server，保留 codex exec --json 为退路', () => {
		it('defaults to app-server mode for buildLaunchSpec', () => {
			const spec = buildLaunchSpec({
				runId: 'run-001',
				cwd: '/workspace/project',
			});

			expect(spec.file).toBe('codex');
			expect(spec.cwd).toBe('/workspace/project');
			expect(spec.args[0]).toBe('app-server');
			expect(spec.args[1]).toBe('--listen');
			expect(spec.args[2]).toBe('stdio://');
			expect(spec.isAcp).toBeUndefined();
			expect(Object.isFrozen(spec)).toBe(true);
			expect(Object.isFrozen(spec.args)).toBe(true);
		});

		it('configures model, effort tier, and sandbox permissions in app-server mode', () => {
			const spec = buildCodexLaunchSpec({
				runId: 'run-002',
				cwd: '/workspace/project',
				model: 'o3-mini',
				effortTier: EFFORT_TIERS.HIGH,
				permissionTier: PERMISSION_TIERS.WORKSPACE_WRITE,
			});

			expect(spec.args).toContain('app-server');
			expect(spec.args).toContain('--listen');
			expect(spec.args).toContain('stdio://');
			expect(spec.args).toContain('-c');
			expect(spec.args).toContain('model="o3-mini"');
			expect(spec.args).toContain('model_reasoning_effort="high"');
			expect(spec.args).toContain('sandbox="workspace-write"');
		});

		it('supports exec --json fallback mode with identical capability settings', () => {
			const spec = buildCodexLaunchSpec({
				runId: 'run-003',
				cwd: '/workspace/project',
				mode: 'exec',
				model: 'o3-mini',
				effortTier: EFFORT_TIERS.HIGH,
				permissionTier: PERMISSION_TIERS.WORKSPACE_WRITE,
				prompt: 'Fix the bug in parser.ts',
			});

			expect(spec.args[0]).toBe('exec');
			expect(spec.args[1]).toBe('--json');
			expect(spec.args).toContain('--model');
			expect(spec.args).toContain('o3-mini');
			expect(spec.args).toContain('--sandbox');
			expect(spec.args).toContain('workspace-write');
			expect(spec.args).toContain('model_reasoning_effort="high"');
			expect(spec.args).toContain('Fix the bug in parser.ts');
		});

		it('detects exec mode from customArgs if specified in template', () => {
			const spec = buildLaunchSpec({
				runId: 'run-004',
				cwd: '/workspace/project',
				customArgs: ['exec', '--json'],
			});

			expect(spec.args[0]).toBe('exec');
			expect(spec.args[1]).toBe('--json');
		});

		it('marks isAcp=true when adapterKind is generic-acp', () => {
			const spec = buildLaunchSpec({
				runId: 'run-005',
				cwd: '/workspace/project',
				adapterKind: 'generic-acp',
			});

			expect(spec.isAcp).toBe(true);
		});
	});

	describe('AC 1: map-events 产出同一套归一化事件 (app-server 与 exec --json)', () => {
		const context = { runId: 'run-test-1', taskId: 'M4-T8' };

		it('maps message chunks identically from app-server and exec --json', () => {
			// app-server line
			const appServerLine = JSON.stringify({
				jsonrpc: '2.0',
				method: 'item/agentMessage/delta',
				params: {
					threadId: 'th-1',
					turnId: 'tu-1',
					itemId: 'msg-1',
					delta: 'Generating solution...',
				},
			});

			// exec --json line
			const execLine = JSON.stringify({
				type: 'item.agent_message.delta',
				delta: 'Generating solution...',
				itemId: 'msg-1',
			});

			const appServerEvents = mapEvents(appServerLine, context);
			const execEvents = mapEvents(execLine, context);

			expect(appServerEvents.length).toBe(1);
			expect(execEvents.length).toBe(1);

			const ev1 = appServerEvents[0];
			const ev2 = execEvents[0];

			expect(ev1?.kind).toBe('agent_message_chunk');
			expect(ev2?.kind).toBe('agent_message_chunk');
			expect(ev1?.payload.chunk).toBe('Generating solution...');
			expect(ev2?.payload.chunk).toBe('Generating solution...');
			expect(ev1?.runId).toBe('run-test-1');
			expect(ev2?.runId).toBe('run-test-1');
		});

		it('maps reasoning/thought chunks identically from app-server and exec --json', () => {
			const appServerLine = JSON.stringify({
				method: 'item/reasoning/textDelta',
				params: {
					delta: 'Analyzing type constraints...',
					itemId: 'rs-1',
				},
			});

			const execLine = JSON.stringify({
				type: 'item.reasoning.delta',
				delta: 'Analyzing type constraints...',
				itemId: 'rs-1',
			});

			const ev1 = mapCodexEvents(appServerLine, context)[0];
			const ev2 = mapCodexEvents(execLine, context)[0];

			expect(ev1?.kind).toBe('agent_thought_chunk');
			expect(ev2?.kind).toBe('agent_thought_chunk');
			expect(ev1?.payload.chunk).toBe('Analyzing type constraints...');
			expect(ev2?.payload.chunk).toBe('Analyzing type constraints...');
		});

		it('maps command execution tool_call started identically from app-server and exec --json', () => {
			const itemPayload = {
				type: 'commandExecution',
				id: 'cmd-42',
				command: 'pnpm test',
				cwd: '/app/repo',
			};

			const appServerLine = JSON.stringify({
				method: 'item/started',
				params: { item: itemPayload },
			});

			const execLine = JSON.stringify({
				type: 'item.started',
				item: itemPayload,
			});

			const ev1 = mapEvents(appServerLine, context)[0];
			const ev2 = mapEvents(execLine, context)[0];

			expect(ev1?.kind).toBe('tool_call');
			expect(ev2?.kind).toBe('tool_call');
			expect(ev1?.payload.callId).toBe('cmd-42');
			expect(ev2?.payload.callId).toBe('cmd-42');
			expect(ev1?.payload.tool).toBe('commandExecution');
			expect(ev2?.payload.tool).toBe('commandExecution');
			expect(ev1?.payload.input).toEqual({ command: 'pnpm test', cwd: '/app/repo' });
			expect(ev2?.payload.input).toEqual({ command: 'pnpm test', cwd: '/app/repo' });
		});

		it('maps command execution tool_call_update completed identically from app-server and exec --json', () => {
			const itemPayload = {
				type: 'commandExecution',
				id: 'cmd-42',
				command: 'pnpm test',
				exitCode: 0,
				aggregatedOutput: '✓ 12 tests passed',
				status: 'completed',
				durationMs: 450,
			};

			const appServerLine = JSON.stringify({
				method: 'item/completed',
				params: { item: itemPayload },
			});

			const execLine = JSON.stringify({
				type: 'item.completed',
				item: itemPayload,
			});

			const ev1 = mapEvents(appServerLine, context)[0];
			const ev2 = mapEvents(execLine, context)[0];

			expect(ev1?.kind).toBe('tool_call_update');
			expect(ev2?.kind).toBe('tool_call_update');
			expect(ev1?.payload.callId).toBe('cmd-42');
			expect(ev2?.payload.callId).toBe('cmd-42');
			expect(ev1?.payload.output).toEqual({
				exitCode: 0,
				aggregatedOutput: '✓ 12 tests passed',
				status: 'completed',
				durationMs: 450,
			});
			expect(ev2?.payload.output).toEqual({
				exitCode: 0,
				aggregatedOutput: '✓ 12 tests passed',
				status: 'completed',
				durationMs: 450,
			});
		});

		it('detects git push and emits run.remote_push_detected in addition to tool_call_update', () => {
			const pushItem = {
				type: 'commandExecution',
				id: 'cmd-push',
				command: 'git push origin task/M4-T8',
				exitCode: 0,
				aggregatedOutput: 'To github.com:owner/repo.git\n * [new branch] task/M4-T8 -> task/M4-T8',
				status: 'completed',
			};

			const events = mapEvents(
				JSON.stringify({ method: 'item/completed', params: { item: pushItem } }),
				context,
			);
			expect(events.length).toBe(2);
			expect(events[0]?.kind).toBe('tool_call_update');
			expect(events[1]?.kind).toBe('run.remote_push_detected');
		});

		it('maps fileChange tool_call and update', () => {
			const startLine = JSON.stringify({
				method: 'item/started',
				params: {
					item: {
						type: 'fileChange',
						id: 'fc-1',
						changes: [{ path: 'src/main.ts', kind: 'modify' }],
					},
				},
			});

			const completeLine = JSON.stringify({
				method: 'item/completed',
				params: {
					item: {
						type: 'fileChange',
						id: 'fc-1',
						status: 'applied',
						changes: [{ path: 'src/main.ts', kind: 'modify' }],
					},
				},
			});

			const startEv = mapEvents(startLine)[0];
			expect(startEv?.kind).toBe('tool_call');
			expect(startEv?.payload.tool).toBe('fileChange');
			expect(startEv?.payload.callId).toBe('fc-1');

			const completeEv = mapEvents(completeLine)[0];
			expect(completeEv?.kind).toBe('tool_call_update');
			expect(completeEv?.payload.callId).toBe('fc-1');
			expect(completeEv?.payload.output).toEqual({
				status: 'applied',
				changes: [{ path: 'src/main.ts', kind: 'modify' }],
			});
		});

		it('maps plans identically from app-server and exec --json', () => {
			const appServerLine = JSON.stringify({
				method: 'turn/plan/updated',
				params: {
					plan: [
						{ step: 1, text: 'Run tests' },
						{ step: 2, text: 'Commit changes' },
					],
				},
			});

			const execLine = JSON.stringify({
				type: 'turn.plan.updated',
				plan: [
					{ step: 1, text: 'Run tests' },
					{ step: 2, text: 'Commit changes' },
				],
			});

			const ev1 = mapEvents(appServerLine)[0];
			const ev2 = mapEvents(execLine)[0];

			expect(ev1?.kind).toBe('plan');
			expect(ev2?.kind).toBe('plan');
			expect(ev1?.payload.entries).toEqual(ev2?.payload.entries);
		});

		it('maps run lifecycle events (started, exited, error, permissions)', () => {
			const startEvents = mapEvents(
				JSON.stringify({ method: 'turn/started', params: { turnId: 't1' } }),
				context,
			);
			expect(startEvents[0]?.kind).toBe('run.started');

			const exit0Events = mapEvents(
				JSON.stringify({ method: 'turn/completed', params: { turnId: 't1' } }),
				context,
			);
			expect(exit0Events[0]?.kind).toBe('run.exited');
			expect(exit0Events[0]?.payload.exitCode).toBe(0);

			const failEvents = mapEvents(JSON.stringify({ type: 'turn.failed' }), context);
			expect(failEvents[0]?.kind).toBe('run.exited');
			expect(failEvents[0]?.payload.exitCode).toBe(1);

			const errorEvents = mapEvents(
				JSON.stringify({ method: 'error', params: { message: 'Token limit exceeded' } }),
			);
			expect(errorEvents[0]?.kind).toBe('run.stderr_line');
			expect(errorEvents[0]?.payload.line).toBe('Token limit exceeded');

			const permEvents = mapEvents(
				JSON.stringify({
					method: 'item/autoApprovalReview/started',
					params: { message: 'Write to /etc denied' },
				}),
			);
			expect(permEvents[0]?.kind).toBe('run.permission_blocked');
			expect(permEvents[0]?.payload.reason).toBe('Write to /etc denied');
		});

		it('gracefully handles unparseable lines and unknown types without crashing or inventing kinds', () => {
			// Unparseable non-JSON line
			const unparseable = parseAndMapCodexLine('this is raw stdout text from some child');
			expect(unparseable.parseError).toBe(true);
			expect(unparseable.events).toEqual([]);

			// Valid JSON with completely unknown vendor event
			const unknownType = parseAndMapCodexLine(
				JSON.stringify({
					method: 'unknown/vendor/event_2026',
					params: { foo: 'bar' },
				}),
			);
			expect(unknownType.unmappedCount).toBe(1);
			expect(unknownType.events).toEqual([]);
		});
	});

	describe('AC 2: 厂商事件字符串只出现在本目录，service/jobs/http 中出现即架构测试失败', () => {
		it('defines CODEX_VENDOR_EVENT_STRINGS containing the vendor event names', () => {
			expect(CODEX_VENDOR_EVENT_STRINGS.length).toBeGreaterThan(10);
			expect(CODEX_VENDOR_EVENT_STRINGS).toContain('thread/started');
			expect(CODEX_VENDOR_EVENT_STRINGS).toContain('item/agentMessage/delta');
			expect(CODEX_VENDOR_EVENT_STRINGS).toContain('commandExecution');
		});

		it('asserts vendor event strings do not appear in service, jobs, or http layers', () => {
			const targetDirectories = ['service', 'jobs', 'http'];
			const violations: { file: string; match: string }[] = [];

			for (const dirName of targetDirectories) {
				const fullDirPath = join(daemonSrc, dirName);
				const files = collectTypeScriptFiles(fullDirPath);

				for (const filePath of files) {
					const content = readFileSync(filePath, 'utf8');
					for (const vendorString of CODEX_VENDOR_EVENT_STRINGS) {
						if (content.includes(`'${vendorString}'`) || content.includes(`"${vendorString}"`)) {
							violations.push({
								file: relative(daemonSrc, filePath).replaceAll('\\', '/'),
								match: vendorString,
							});
						}
					}
				}
			}

			expect(violations).toEqual([]);
		});
	});

	describe('readModels integration', () => {
		it('exports readModels and readCodexModels from codex adapter', () => {
			expect(typeof readModels).toBe('function');
			expect(typeof readCodexModels).toBe('function');
		});
	});
});

function collectTypeScriptFiles(dir: string): string[] {
	const results: string[] = [];
	let entries: import('node:fs').Dirent[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTypeScriptFiles(fullPath));
		} else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.endsWith('.test.ts')) {
			results.push(fullPath);
		}
	}
	return results;
}
