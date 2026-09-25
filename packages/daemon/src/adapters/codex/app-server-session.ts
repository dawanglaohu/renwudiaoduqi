import { AppError } from '../../errors/app-error.ts';
import type { ManagedProcess } from '../../proc/spawn.ts';

type JsonRecord = Record<string, unknown>;

interface PendingApproval {
	readonly id: string | number;
	readonly method: string;
	readonly threadId: string;
	readonly turnId: string;
	readonly itemId: string;
	readonly requestedPermissions?: JsonRecord;
	reserved: boolean;
}

export interface CodexAppServerSession {
	start(input: {
		readonly prompt: string;
		readonly model?: string | null;
		readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
	}): Promise<void>;
	hasPendingApproval(): boolean;
	getTurnExitCode(): number | null;
	sendText(text: string): Promise<void>;
	approveOnce(): Promise<void>;
	dispose(): void;
}

export interface CodexSessionRegistry {
	register(runId: string, process: ManagedProcess): CodexAppServerSession;
	get(runId: string): CodexAppServerSession | undefined;
}

const STARTUP_TIMEOUT_MS = 15_000;
const APPROVAL_TIMEOUT_MS = 10_000;
const APPROVAL_METHODS = new Set([
	'item/commandExecution/requestApproval',
	'item/fileChange/requestApproval',
	'item/permissions/requestApproval',
]);

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function protocolError(message: string, runId: string): AppError {
	return new AppError('E_MESSAGE_UNDELIVERED', message, {
		details: { runId, reason: 'codex_protocol_unavailable' },
	});
}

/** A single app-server process, thread, and turn belong to exactly one run. */
export function createCodexSessionRegistry(): CodexSessionRegistry {
	const sessions = new Map<string, CodexAppServerSession>();

	return Object.freeze({
		register(runId: string, process: ManagedProcess): CodexAppServerSession {
			sessions.get(runId)?.dispose();
			let disposed = false;
			let threadId: string | null = null;
			let turnId: string | null = null;
			let pending: PendingApproval | null = null;
			let turnExitCode: number | null = null;
			let nextId = 1;
			const replies = new Map<
				number,
				{
					resolve: (value: JsonRecord) => void;
					reject: (error: Error) => void;
				}
			>();
			const resolved = new Map<
				string | number,
				{ resolve: () => void; reject: (error: Error) => void }
			>();

			function live(): boolean {
				return (
					!disposed &&
					!process.isExited &&
					!process.child.killed &&
					process.child.stdin !== null &&
					!process.child.stdin.destroyed &&
					process.child.stdin.writable
				);
			}

			async function write(message: JsonRecord): Promise<void> {
				if (!live()) throw protocolError('Codex approval session is no longer live.', runId);
				try {
					if (!process.writeStdin(`${JSON.stringify(message)}\n`)) {
						await process.waitForStdinDrain();
						if (!live()) throw protocolError('Codex approval pipe closed.', runId);
					}
				} catch {
					throw protocolError('Codex protocol write failed.', runId);
				}
			}

			async function request(method: string, params: JsonRecord): Promise<JsonRecord> {
				const id = nextId++;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const reply = new Promise<JsonRecord>((resolve, reject) => {
					replies.set(id, { resolve, reject });
					timer = setTimeout(() => {
						replies.delete(id);
						reject(protocolError(`Codex ${method} timed out.`, runId));
					}, STARTUP_TIMEOUT_MS);
				});
				try {
					await write({ id, method, params });
					return await reply;
				} finally {
					if (timer) clearTimeout(timer);
					replies.delete(id);
				}
			}

			const offJson = process.onJson((line) => {
				const message = record(line.value);
				if (!message || disposed) return;
				if (typeof message.id === 'number' && replies.has(message.id)) {
					const waiter = replies.get(message.id);
					replies.delete(message.id);
					if (message.error)
						waiter?.reject(protocolError('Codex app-server rejected a request.', runId));
					else waiter?.resolve(record(message.result) ?? {});
					return;
				}
				const method = message.method;
				const params = record(message.params);
				if (method === 'turn/started' && params?.threadId === threadId) {
					const turn = record(params.turn);
					if (typeof turn?.id === 'string') turnId = turn.id;
				}
				if (
					typeof method === 'string' &&
					APPROVAL_METHODS.has(method) &&
					params &&
					(typeof message.id === 'number' || typeof message.id === 'string') &&
					params.threadId === threadId &&
					typeof params.turnId === 'string' &&
					typeof params.itemId === 'string' &&
					(!turnId || params.turnId === turnId) &&
					(method !== 'item/permissions/requestApproval' || record(params.permissions))
				) {
					pending = {
						id: message.id,
						method,
						threadId: params.threadId as string,
						turnId: params.turnId,
						itemId: params.itemId,
						...(method === 'item/permissions/requestApproval'
							? { requestedPermissions: record(params.permissions) ?? {} }
							: {}),
						reserved: false,
					};
					return;
				}
				if (
					method === 'serverRequest/resolved' &&
					params &&
					(typeof params.requestId === 'number' || typeof params.requestId === 'string')
				) {
					const onResolved = resolved.get(params.requestId);
					resolved.delete(params.requestId);
					if (pending?.id === params.requestId) pending = null;
					onResolved?.resolve();
				}
				if (method === 'turn/completed' && params?.threadId === threadId) {
					pending = null;
					const turn = record(params.turn);
					turnExitCode = turn?.status === 'failed' ? 1 : turn?.status === 'interrupted' ? 130 : 0;
					// The app-server stays alive after a turn. EOF ends this run's dedicated process.
					process.child.stdin?.end();
				}
			});

			const session: CodexAppServerSession = Object.freeze({
				async start(input: {
					readonly prompt: string;
					readonly model?: string | null;
					readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
				}) {
					await request('initialize', {
						clientInfo: { name: 'agent_scheduler', title: 'Agent Scheduler', version: '0.1.0' },
					});
					await write({ method: 'initialized', params: {} });
					const started = await request('thread/start', {
						cwd: process.cwd,
						approvalPolicy: 'on-request',
						sandbox: input.sandbox,
						...(input.model ? { model: input.model } : {}),
					});
					const thread = record(started.thread);
					if (typeof thread?.id !== 'string')
						throw protocolError('Codex did not return a thread ID.', runId);
					threadId = thread.id;
					const turnStarted = await request('turn/start', {
						threadId,
						cwd: process.cwd,
						input: [{ type: 'text', text: input.prompt }],
					});
					const turn = record(turnStarted.turn);
					if (typeof turn?.id !== 'string')
						throw protocolError('Codex did not return a turn ID.', runId);
					turnId = turn.id;
				},
				hasPendingApproval() {
					return live() && pending !== null && !pending.reserved;
				},
				getTurnExitCode() {
					return turnExitCode;
				},
				async sendText(text: string) {
					if (!live() || !threadId || !turnId || turnExitCode !== null) {
						throw protocolError('Codex turn is no longer accepting messages.', runId);
					}
					await request('turn/steer', {
						threadId,
						expectedTurnId: turnId,
						input: [{ type: 'text', text }],
					});
				},
				async approveOnce() {
					const approval = pending;
					if (!live() || !approval || approval.reserved) {
						throw protocolError('No live Codex approval request is pending for this run.', runId);
					}
					approval.reserved = true;
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						const acknowledgement = new Promise<void>((resolve, reject) => {
							resolved.set(approval.id, { resolve, reject });
							timer = setTimeout(
								() => reject(protocolError('Codex approval was not acknowledged.', runId)),
								APPROVAL_TIMEOUT_MS,
							);
						});
						const requested = approval.requestedPermissions;
						const result =
							approval.method === 'item/permissions/requestApproval'
								? {
										permissions: {
											...(record(requested?.fileSystem)
												? { fileSystem: requested?.fileSystem }
												: {}),
											...(record(requested?.network) ? { network: requested?.network } : {}),
										},
										scope: 'turn',
									}
								: { decision: 'acceptForSession' };
						await write({ id: approval.id, result });
						await acknowledgement;
					} finally {
						if (timer) clearTimeout(timer);
						resolved.delete(approval.id);
						pending = null; // A sent response is never replayed, even if acknowledgement is lost.
					}
				},
				dispose() {
					if (disposed) return;
					disposed = true;
					pending = null;
					offJson();
					for (const waiter of replies.values())
						waiter.reject(protocolError('Codex process exited.', runId));
					replies.clear();
					for (const waiter of resolved.values())
						waiter.reject(protocolError('Codex approval session ended.', runId));
					resolved.clear();
					if (sessions.get(runId) === session) sessions.delete(runId);
				},
			});
			process.onExit(() => session.dispose());
			sessions.set(runId, session);
			return session;
		},
		get(runId: string) {
			return sessions.get(runId);
		},
	});
}
