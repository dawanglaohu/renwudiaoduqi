import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeGuardHandlers, registerRuntimeGuards } from '../../src/boot/guards.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('runtime guards', () => {
	it('E-213 writes unhandled rejections to the injected run log', () => {
		const lines: string[] = [];
		const fatalExit = vi.fn();
		const handlers = createRuntimeGuardHandlers({
			pid: 42,
			writeRunLog: (line) => lines.push(line),
			fatalExit,
		});

		handlers.unhandledRejection(new Error('lost promise'));

		expect(lines).toEqual([
			'[unhandledRejection] Error: lost promise in process 42. Unawaited promises must be written as explicit `void fn()` fire-and-forget. See E-213.',
		]);
		expect(fatalExit).not.toHaveBeenCalled();
	});

	it('logs an uncaught exception before invoking the injected fatal exit', () => {
		const calls: string[] = [];
		const handlers = createRuntimeGuardHandlers({
			pid: 73,
			writeRunLog: (line) => calls.push(`log:${line}`),
			fatalExit: () => calls.push('exit'),
		});

		handlers.uncaughtException('fatal value');

		expect(calls).toEqual(['log:[uncaughtException] fatal value in process 73.', 'exit']);
	});

	it('invokes fatal exit even if the run-log writer fails', () => {
		const fatalExit = vi.fn();
		const handlers = createRuntimeGuardHandlers({
			pid: 73,
			writeRunLog: () => {
				throw new TypeError('disk unavailable');
			},
			fatalExit,
		});

		expect(() => handlers.uncaughtException(new Error('fatal'))).toThrow('disk unavailable');
		expect(fatalExit).toHaveBeenCalledOnce();
	});

	it('registers both process handlers', () => {
		const on = vi.spyOn(process, 'on').mockImplementation(() => process);
		registerRuntimeGuards({
			pid: 1,
			writeRunLog: vi.fn(),
			fatalExit: vi.fn(),
		});

		expect(on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
		expect(on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
	});
});
