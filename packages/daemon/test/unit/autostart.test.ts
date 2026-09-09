import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import { describe, expect, it, vi } from 'vitest';
import { createAutostartRegistrar, register } from '../../src/boot/autostart.ts';
import type {
	AutostartAdapter,
	AutostartOperationResult,
	AutostartStatus,
	AutostartVoidResult,
} from '../../src/platform/autostart-contract.ts';

const VALID_SPEC: DaemonLaunchSpec = Object.freeze({
	file: '/opt/agent-scheduler/bin/daemon',
	args: Object.freeze(['--port', '7817', '--data-dir', '/var/data/agent-scheduler']),
	cwd: '/opt/agent-scheduler',
});

interface MutableAutostartStatus {
	registered: boolean;
	matchesSpec: boolean;
	recordedSpec?: DaemonLaunchSpec;
}

function createMockAdapter(
	initialStatus: AutostartStatus = { registered: false, matchesSpec: false },
): {
	adapter: AutostartAdapter;
	currentStatus: MutableAutostartStatus;
	registeredSpecs: DaemonLaunchSpec[];
	unregisteredCalls: number;
} {
	const currentStatus: MutableAutostartStatus = {
		registered: initialStatus.registered,
		matchesSpec: initialStatus.matchesSpec,
		recordedSpec: initialStatus.recordedSpec,
	};
	const registeredSpecs: DaemonLaunchSpec[] = [];
	let unregisteredCalls = 0;

	const adapter: AutostartAdapter = {
		register: vi.fn(async (spec: DaemonLaunchSpec): Promise<AutostartVoidResult> => {
			registeredSpecs.push(spec);
			currentStatus.registered = true;
			currentStatus.matchesSpec = true;
			currentStatus.recordedSpec = spec;
			return Object.freeze({ ok: true, value: null });
		}),
		status: vi.fn(
			async (spec: DaemonLaunchSpec): Promise<AutostartOperationResult<AutostartStatus>> => {
				const matches =
					currentStatus.recordedSpec !== undefined &&
					currentStatus.recordedSpec.file === spec.file &&
					currentStatus.recordedSpec.cwd === spec.cwd &&
					currentStatus.recordedSpec.args.length === spec.args.length &&
					currentStatus.recordedSpec.args.every((a, i) => a === spec.args[i]);
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						registered: currentStatus.registered,
						matchesSpec: matches,
						recordedSpec: currentStatus.recordedSpec,
					}),
				});
			},
		),
		unregister: vi.fn(async (): Promise<AutostartVoidResult> => {
			unregisteredCalls++;
			currentStatus.registered = false;
			currentStatus.matchesSpec = false;
			currentStatus.recordedSpec = undefined;
			return Object.freeze({ ok: true, value: null });
		}),
		manualStartCommand: (spec: DaemonLaunchSpec): string =>
			`cd '${spec.cwd}' && exec '${spec.file}' ${spec.args.map((a) => `'${a}'`).join(' ')}`,
		manualUnregisterCommand: 'systemctl --user disable --now daemon.service',
	};

	return { adapter, currentStatus, registeredSpecs, unregisteredCalls };
}

describe('boot/autostart', () => {
	it('AC 1 & E-209: registers with absolute file, args[], cwd and is idempotent on repeat', async () => {
		const harness = createMockAdapter();
		const result1 = await register(VALID_SPEC, harness.adapter);

		expect(result1.ok).toBe(true);
		if (result1.ok) {
			expect(result1.registered).toBe(true);
			expect(result1.matchesSpec).toBe(true);
		}
		expect(harness.registeredSpecs).toHaveLength(1);
		expect(harness.registeredSpecs[0]).toEqual(VALID_SPEC);

		// Second call with same spec: idempotent, does not call register a second time
		const result2 = await register(VALID_SPEC, harness.adapter);
		expect(result2.ok).toBe(true);
		if (result2.ok) {
			expect(result2.registered).toBe(true);
			expect(result2.matchesSpec).toBe(true);
			expect(result2.rewritten).toBe(false);
		}
		expect(harness.registeredSpecs).toHaveLength(1);
	});

	it('AC 1 & E-209: rewrites native autostart when any field changes (upgrade/relocation)', async () => {
		const harness = createMockAdapter({
			registered: true,
			matchesSpec: false,
			recordedSpec: {
				file: '/old-path/bin/daemon',
				args: ['--port', '7817'],
				cwd: '/old-path',
			},
		});

		const result = await register(VALID_SPEC, harness.adapter);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.rewritten).toBe(true);
		}
		expect(harness.registeredSpecs).toHaveLength(1);
		expect(harness.registeredSpecs[0]).toEqual(VALID_SPEC);
	});

	it('AC 1: rejects non-absolute file or cwd with E_VALIDATION and does not crash', async () => {
		const harness = createMockAdapter();
		const relativeSpec = {
			file: 'bin/daemon',
			args: [],
			cwd: '/opt/agent-scheduler',
		};

		const result = await register(relativeSpec, harness.adapter);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('E_VALIDATION');
		}
		expect(harness.registeredSpecs).toHaveLength(0);
	});

	it('AC 1 & E-210: native registration denial is non-fatal and includes manual command', async () => {
		const harness = createMockAdapter();
		(harness.adapter.register as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			Object.freeze({
				ok: false,
				error: Object.freeze({
					code: 'E_AUTOSTART_REGISTER_DENIED',
					message: 'Access is denied by system policy.',
					details: Object.freeze({ reason: 'access_denied' }),
				}),
			}),
		);

		const result = await register(VALID_SPEC, harness.adapter);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('E_AUTOSTART_REGISTER_DENIED');
			expect(result.manualStartCommand).toContain('/opt/agent-scheduler/bin/daemon');
			expect(result.error.details.manualStartCommand).toBe(result.manualStartCommand);
		}
	});

	it('AC 2 & E-261: Linux without user systemd returns unsupported and manual command without writing system service', async () => {
		const harness = createMockAdapter();
		(harness.adapter.status as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			Object.freeze({
				ok: false,
				error: Object.freeze({
					code: 'E_AUTOSTART_UNSUPPORTED',
					message: 'The current host does not provide the required user autostart service.',
					details: Object.freeze({ systemd: 'user-instance-missing' }),
				}),
			}),
		);

		const result = await register(VALID_SPEC, harness.adapter);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('E_AUTOSTART_UNSUPPORTED');
			expect(result.manualStartCommand).toBeDefined();
			expect(result.manualStartCommand).toContain('exec');
		}
		// Must not attempt to call register when status reports unsupported
		expect(harness.registeredSpecs).toHaveLength(0);
	});

	it('createAutostartRegistrar binds adapter and exposes status and unregister helpers', async () => {
		const harness = createMockAdapter();
		const registrar = createAutostartRegistrar(harness.adapter);

		const regResult = await registrar.register(VALID_SPEC);
		expect(regResult.ok).toBe(true);

		const statusResult = await registrar.status(VALID_SPEC);
		expect(statusResult.ok).toBe(true);
		if (statusResult.ok) {
			expect(statusResult.value.registered).toBe(true);
			expect(statusResult.value.matchesSpec).toBe(true);
		}

		expect(registrar.manualStartCommand(VALID_SPEC)).toContain('/opt/agent-scheduler/bin/daemon');

		const unregResult = await registrar.unregister();
		expect(unregResult.ok).toBe(true);
		expect(harness.currentStatus.registered).toBe(false);
	});

	it('handles throwing adapter functions gracefully without unhandled rejection', async () => {
		const throwingAdapter: AutostartAdapter = {
			register: async () => {
				throw new Error('OS failure');
			},
			status: async () => {
				throw new Error('OS failure');
			},
			unregister: async () => {
				throw new Error('OS failure');
			},
			manualStartCommand: (spec) => `start ${spec.file}`,
			manualUnregisterCommand: 'rm autostart',
		};

		const result = await register(VALID_SPEC, throwingAdapter);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('E_AUTOSTART_UNSUPPORTED');
			expect(result.manualStartCommand).toBe('start /opt/agent-scheduler/bin/daemon');
		}
	});
});
