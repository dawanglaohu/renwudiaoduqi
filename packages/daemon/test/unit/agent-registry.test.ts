import { describe, expect, it } from 'vitest';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import {
	type AgentRegistryFileSystem,
	type AgentRegistryTimers,
	type AgentRegistryWarning,
	createAgentRegistry,
} from '../../src/config/registry.ts';

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

interface MemoryFileSystem {
	readonly fileSystem: AgentRegistryFileSystem;
	getContents(): string | undefined;
	getWriteCount(): number;
	setContents(contents: string): void;
	emitChange(count?: number): void;
	beforeFirstReadReturn(callback: () => void): void;
}

interface ManualTimers {
	readonly timers: AgentRegistryTimers;
	getClearCount(): number;
	getSetCount(): number;
	fire(): void;
}

describe('agent registry lifecycle', () => {
	it('persists a complete baseline when defaults are absent or empty', async () => {
		for (const initialContents of [
			undefined,
			JSON.stringify({ defaults: {}, overrides: { codex: { maxConcurrency: 2 } } }),
		]) {
			const memory = createMemoryFileSystem(initialContents);
			const registry = createAgentRegistry({
				dataDir: 'C:\\agent-scheduler-test',
				fileSystem: memory.fileSystem,
				publishWarning() {},
			});

			const snapshot = await registry.start();
			registry.stop();

			const persisted = parsePersistedFile(memory.getContents());
			expect(requiredEntry(persisted.defaults, 'codex')).toEqual(BUILT_IN_AGENT_DEFAULTS.codex);
			expect(requiredEntry(persisted.defaults, 'claude')).toEqual(BUILT_IN_AGENT_DEFAULTS.claude);
			expect(requiredEntry(snapshot.storedDefaults, 'codex')).toEqual(
				BUILT_IN_AGENT_DEFAULTS.codex,
			);
			if (initialContents !== undefined) {
				expect(requiredEntry(persisted.overrides, 'codex').maxConcurrency).toBe(2);
				expect(requiredEntry(snapshot.agents, 'codex').maxConcurrency).toBe(2);
			}
		}
	});

	it('completes a partial historical baseline and preserves it across upgrade and adoption', async () => {
		const memory = createMemoryFileSystem(
			JSON.stringify({
				defaults: { codex: { maxConcurrency: 1 } },
				overrides: { codex: { maxConcurrency: 2, monogram: 'ZZ' } },
			}),
		);
		const firstVersion = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			publishWarning() {},
		});
		await firstVersion.start();
		firstVersion.stop();

		const completed = parsePersistedFile(memory.getContents());
		expect(requiredEntry(completed.defaults, 'codex').maxConcurrency).toBe(1);
		expect(requiredEntry(completed.defaults, 'codex').execPath).toBe(
			BUILT_IN_AGENT_DEFAULTS.codex.execPath,
		);
		expect(requiredEntry(completed.defaults, 'claude')).toEqual(BUILT_IN_AGENT_DEFAULTS.claude);
		expect(requiredEntry(completed.overrides, 'codex')).toEqual({
			maxConcurrency: 2,
			monogram: 'ZZ',
		});

		const upgradedDefaults = {
			...BUILT_IN_AGENT_DEFAULTS,
			codex: { ...BUILT_IN_AGENT_DEFAULTS.codex, maxConcurrency: 3 },
		};
		const secondVersion = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			builtInDefaults: upgradedDefaults,
			publishWarning() {},
		});
		const upgraded = await secondVersion.start();
		expect(upgraded.defaultUpdates).toEqual([
			expect.objectContaining({
				agentId: 'codex',
				field: 'maxConcurrency',
				oldValue: 1,
				newValue: 3,
				userValue: 2,
			}),
		]);

		const adopted = await secondVersion.adoptDefault('codex', 'maxConcurrency');
		expect(adopted.ok).toBe(true);
		if (!adopted.ok) return;
		expect(requiredEntry(adopted.reload.snapshot.agents, 'codex').maxConcurrency).toBe(3);
		expect(requiredEntry(adopted.reload.snapshot.agents, 'codex').monogram).toBe('ZZ');
		expect(requiredEntry(adopted.reload.snapshot.userOverrides, 'codex')).toEqual({
			monogram: 'ZZ',
		});
		secondVersion.stop();
	});

	it('keeps baseline persistence failure nonfatal and publishes a warning', async () => {
		const warnings: AgentRegistryWarning[] = [];
		const memory = createMemoryFileSystem(undefined, true);
		const registry = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			publishWarning: (warning) => warnings.push(warning),
		});

		const snapshot = await registry.start();
		registry.stop();

		expect(requiredEntry(snapshot.agents, 'codex').maxConcurrency).toBe(1);
		expect(warnings).toEqual([
			expect.objectContaining({ kind: 'agent.availability_changed', reason: 'write-failed' }),
		]);
	});

	it('watches before the first read and deduplicates repeated save events', async () => {
		const completeDefaults = JSON.parse(JSON.stringify(BUILT_IN_AGENT_DEFAULTS));
		const memory = createMemoryFileSystem(
			JSON.stringify({ schemaVersion: 1, defaults: completeDefaults, overrides: {} }),
		);
		const manual = createManualTimers();
		let reloadCount = 0;
		memory.beforeFirstReadReturn(() => {
			memory.setContents(
				JSON.stringify({
					schemaVersion: 1,
					defaults: completeDefaults,
					overrides: { codex: { maxConcurrency: 2 } },
				}),
			);
			memory.emitChange(3);
		});
		const registry = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			timers: manual.timers,
			publishWarning() {},
			onReload() {
				reloadCount += 1;
			},
		});

		const initial = await registry.start();
		expect(requiredEntry(initial.agents, 'codex').maxConcurrency).toBe(1);
		expect(manual.getSetCount()).toBe(3);
		expect(manual.getClearCount()).toBe(2);

		manual.fire();
		await registry.reload();
		expect(requiredEntry(registry.getSnapshot().agents, 'codex').maxConcurrency).toBe(2);
		expect(reloadCount).toBe(2);
		registry.stop();
	});

	it('rejects initial start with invalid template, retains baseline, and publishes detailed warning', async () => {
		const warnings: AgentRegistryWarning[] = [];
		const memory = createMemoryFileSystem(
			JSON.stringify({
				overrides: {
					codex: {
						argsTemplate: ['exec', '--model={unknown_var}'],
					},
				},
			}),
		);
		const registry = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			publishWarning: (w) => warnings.push(w),
		});

		const snapshot = await registry.start();
		registry.stop();

		expect(snapshot.generation).toBe(0);
		expect(requiredEntry(snapshot.agents, 'codex').argsTemplate).toEqual(
			BUILT_IN_AGENT_DEFAULTS.codex.argsTemplate,
		);

		const invalidWarning = warnings.find((w) => w.reason === 'invalid-config');
		expect(invalidWarning).toBeDefined();
		expect(invalidWarning?.agentId).toBe('codex');
		expect(invalidWarning?.field).toBe('$.overrides.codex.argsTemplate');
		expect(invalidWarning?.argumentIndex).toBe(1);
		expect(invalidWarning?.startIndex).toBe(8);
		expect(invalidWarning?.endIndex).toBe(21);
		expect(invalidWarning?.highlight).toBe('--model={unknown_var}\n        ^^^^^^^^^^^^^');
	});

	it('rejects hot reload with invalid template and preserves previous valid version', async () => {
		const warnings: AgentRegistryWarning[] = [];
		const memory = createMemoryFileSystem(
			JSON.stringify({
				overrides: {
					codex: { maxConcurrency: 2 },
				},
			}),
		);
		const registry = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			publishWarning: (w) => warnings.push(w),
		});

		const initialSnapshot = await registry.start();
		expect(initialSnapshot.generation).toBe(1);
		expect(requiredEntry(initialSnapshot.agents, 'codex').maxConcurrency).toBe(2);

		memory.setContents(
			JSON.stringify({
				overrides: {
					codex: {
						argsTemplate: ['exec', '--model={model'],
					},
				},
			}),
		);

		const reloadResult = await registry.reload();
		expect(reloadResult.status).toBe('rejected');
		expect(reloadResult.snapshot.generation).toBe(1);
		expect(requiredEntry(registry.getSnapshot().agents, 'codex').maxConcurrency).toBe(2);

		const invalidWarning = warnings.find((w) => w.reason === 'invalid-config');
		expect(invalidWarning).toBeDefined();
		expect(invalidWarning?.agentId).toBe('codex');
		expect(invalidWarning?.field).toBe('$.overrides.codex.argsTemplate');
		expect(invalidWarning?.argumentIndex).toBe(1);
		expect(invalidWarning?.startIndex).toBe(8);
		expect(invalidWarning?.endIndex).toBe(14);
		expect(invalidWarning?.highlight).toBe('--model={model\n        ^^^^^^');

		registry.stop();
	});

	it('warns when two agents share executable path and session directory but does not reject', async () => {
		const warnings: AgentRegistryWarning[] = [];
		const memory = createMemoryFileSystem(
			JSON.stringify({
				overrides: {
					claude: {
						execPath: 'codex',
					},
				},
			}),
		);
		const registry = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			publishWarning: (w) => warnings.push(w),
		});

		const snapshot = await registry.start();
		registry.stop();

		expect(requiredEntry(snapshot.agents, 'claude').execPath).toBe('codex');
		expect(requiredEntry(snapshot.agents, 'codex').execPath).toBe('codex');

		const overlapWarning = warnings.find((w) => w.reason === 'session-dir-overlap');
		expect(overlapWarning).toBeDefined();
		expect(overlapWarning?.reason).toBe('session-dir-overlap');
		expect(overlapWarning?.message).toBe('Session records may overwrite each other');
		expect(overlapWarning?.agentId).toBe('codex');
		expect(overlapWarning?.peerAgentId).toBe('claude');
	});

	it('does not warn when two agents share executable path but have different session directories', async () => {
		const warnings: AgentRegistryWarning[] = [];
		const memory = createMemoryFileSystem(
			JSON.stringify({
				overrides: {
					codex: {
						argsTemplate: ['exec', '--session-dir', '/sessions/codex'],
					},
					claude: {
						execPath: 'codex',
						argsTemplate: ['exec', '--session-dir', '/sessions/claude'],
					},
				},
			}),
		);
		const registry = createAgentRegistry({
			dataDir: 'C:\\agent-scheduler-test',
			fileSystem: memory.fileSystem,
			publishWarning: (w) => warnings.push(w),
		});

		const snapshot = await registry.start();
		registry.stop();

		expect(requiredEntry(snapshot.agents, 'claude').execPath).toBe('codex');
		expect(requiredEntry(snapshot.agents, 'codex').execPath).toBe('codex');

		const overlapWarning = warnings.find((w) => w.reason === 'session-dir-overlap');
		expect(overlapWarning).toBeUndefined();
	});
});

function createMemoryFileSystem(
	initialContents: string | undefined,
	isWriteFailure = false,
): MemoryFileSystem {
	let contents = initialContents;
	let listener: WatchListener | undefined;
	let firstReadCallback: (() => void) | undefined;
	let readCount = 0;
	let writeCount = 0;

	return {
		fileSystem: {
			async readUtf8File(): Promise<string> {
				if (contents === undefined) return Promise.reject({ code: 'ENOENT' });
				const captured = contents;
				if (readCount === 0) firstReadCallback?.();
				readCount += 1;
				return captured;
			},
			async writeUtf8File(_path: string, nextContents: string): Promise<void> {
				writeCount += 1;
				if (isWriteFailure) return Promise.reject({ code: 'EACCES' });
				contents = nextContents;
				listener?.('change', 'agents.json');
			},
			watchDirectory(_path: string, nextListener: WatchListener) {
				listener = nextListener;
				return {
					close() {},
					on() {
						return this;
					},
				};
			},
		},
		getContents: () => contents,
		getWriteCount: () => writeCount,
		setContents(nextContents: string) {
			contents = nextContents;
		},
		emitChange(count = 1) {
			for (let index = 0; index < count; index += 1) listener?.('change', 'agents.json');
		},
		beforeFirstReadReturn(callback: () => void) {
			firstReadCallback = callback;
		},
	};
}

function createManualTimers(): ManualTimers {
	let callback: (() => void) | undefined;
	let clearCount = 0;
	let setCount = 0;
	return {
		timers: {
			setTimeout(nextCallback) {
				callback = nextCallback;
				setCount += 1;
				return setCount as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout() {
				callback = undefined;
				clearCount += 1;
			},
		},
		getClearCount: () => clearCount,
		getSetCount: () => setCount,
		fire() {
			const scheduled = callback;
			callback = undefined;
			scheduled?.();
		},
	};
}

function requiredEntry<T>(record: Readonly<Record<string, T>>, key: string): T {
	const value = record[key];
	expect(value).toBeDefined();
	return value as T;
}

function parsePersistedFile(contents: string | undefined): {
	defaults: Record<string, Record<string, unknown>>;
	overrides: Record<string, Record<string, unknown>>;
} {
	expect(contents).toBeDefined();
	return JSON.parse(contents ?? '{}');
}
