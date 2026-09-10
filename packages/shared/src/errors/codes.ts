export interface ErrorCodeMetadata {
	readonly defaultHttpStatus: number | null;
	readonly retryable: boolean;
	readonly origin: 'server' | 'client';
}

export const ERROR_CODES = {
	E_VALIDATION: { defaultHttpStatus: 400, retryable: false, origin: 'server' },
	E_UNAUTHORIZED: { defaultHttpStatus: 401, retryable: false, origin: 'server' },
	E_PAIRING_CODE_INVALID: { defaultHttpStatus: 401, retryable: false, origin: 'server' },
	E_FORBIDDEN: { defaultHttpStatus: 403, retryable: false, origin: 'server' },
	E_NOT_FOUND: { defaultHttpStatus: 404, retryable: false, origin: 'server' },
	E_RUN_ALREADY_EXISTS: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_PATH_CLASH_QUEUED: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_REPLAY_WINDOW_EXPIRED: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_DOC_SOURCE_UNREADABLE: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_DOC_CONTRACT_PENDING: {
		defaultHttpStatus: 409,
		retryable: false,
		origin: 'server',
	},
	E_TASK_REMOVED_FROM_DOC: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_SNAPSHOT_STALE: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_UPSTREAM_BASE_MISSING: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_AGENT_UNAVAILABLE: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_AGENT_VERSION_UNRECOGNIZED: {
		defaultHttpStatus: 409,
		retryable: false,
		origin: 'server',
	},
	E_AGENT_BUSY: { defaultHttpStatus: 429, retryable: true, origin: 'server' },
	E_RATE_LIMITED: { defaultHttpStatus: 429, retryable: true, origin: 'server' },
	E_MODEL_INVALID: { defaultHttpStatus: 422, retryable: false, origin: 'server' },
	E_MESSAGE_UNDELIVERED: { defaultHttpStatus: 422, retryable: false, origin: 'server' },
	E_CAPABILITY_UNSUPPORTED: { defaultHttpStatus: 422, retryable: false, origin: 'server' },
	E_WORKSPACE_UNAVAILABLE: { defaultHttpStatus: 500, retryable: false, origin: 'server' },
	E_NOT_A_GIT_REPO: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_AGENT_STARTUP_TIMEOUT: { defaultHttpStatus: 504, retryable: false, origin: 'server' },
	E_AGENT_EXEC_NOT_FOUND: { defaultHttpStatus: 500, retryable: false, origin: 'server' },
	E_AGENT_EXEC_NOT_EXECUTABLE: {
		defaultHttpStatus: 422,
		retryable: false,
		origin: 'server',
	},
	E_AGENT_EXEC_INVALID_TARGET: {
		defaultHttpStatus: 422,
		retryable: false,
		origin: 'server',
	},
	E_LOG_FILE_MISSING: { defaultHttpStatus: 404, retryable: false, origin: 'server' },
	E_DB_BUSY: { defaultHttpStatus: 503, retryable: true, origin: 'server' },
	E_TX_NESTED: { defaultHttpStatus: 500, retryable: false, origin: 'server' },
	E_DISK_FULL: { defaultHttpStatus: 507, retryable: false, origin: 'server' },
	E_PLATFORM_UNSUPPORTED: { defaultHttpStatus: 501, retryable: false, origin: 'server' },
	E_AUTOSTART_UNSUPPORTED: { defaultHttpStatus: 501, retryable: false, origin: 'server' },
	E_AUTOSTART_REGISTER_DENIED: { defaultHttpStatus: 500, retryable: false, origin: 'server' },
	E_AUTOSTART_UNREGISTER_DENIED: {
		defaultHttpStatus: 500,
		retryable: false,
		origin: 'server',
	},
	E_DATA_DIR_UNRESOLVABLE: { defaultHttpStatus: 500, retryable: false, origin: 'server' },
	E_INVALID_STATE_TRANSITION: {
		defaultHttpStatus: 500,
		retryable: false,
		origin: 'server',
	},
	E_GATE_ALREADY_DECIDED: { defaultHttpStatus: 409, retryable: false, origin: 'server' },
	E_LOG_PURGED: { defaultHttpStatus: 410, retryable: false, origin: 'server' },
	E_DEVICE_REVOKED: { defaultHttpStatus: 401, retryable: false, origin: 'server' },
	E_NETWORK: { defaultHttpStatus: null, retryable: true, origin: 'client' },
	E_TIMEOUT: { defaultHttpStatus: null, retryable: true, origin: 'client' },
	E_SHELL_UNAVAILABLE: { defaultHttpStatus: null, retryable: false, origin: 'client' },
	E_INTERNAL: { defaultHttpStatus: 500, retryable: false, origin: 'server' },
} as const satisfies Record<string, ErrorCodeMetadata>;

export type ErrorCode = keyof typeof ERROR_CODES;
