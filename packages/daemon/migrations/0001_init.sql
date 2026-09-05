CREATE TABLE documents (
	id TEXT PRIMARY KEY,
	docs_path TEXT NOT NULL UNIQUE,
	project_name TEXT NOT NULL,
	repo_path TEXT,
	main_branch TEXT NOT NULL DEFAULT 'main',
	branch_prefix TEXT NOT NULL DEFAULT 'task/',
	lane_count INTEGER NOT NULL DEFAULT 2 CHECK (lane_count BETWEEN 1 AND 6),
	content_fingerprint TEXT NOT NULL,
	is_source_readable INTEGER NOT NULL DEFAULT 1 CHECK (is_source_readable IN (0, 1)),
	is_takeover_notified INTEGER NOT NULL DEFAULT 0 CHECK (is_takeover_notified IN (0, 1)),
	imported_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);

CREATE TABLE batches (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
	batch_no INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'paused', 'done')),
	started_at TEXT,
	finished_at TEXT,
	UNIQUE (doc_id, batch_no)
);

CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
	task_key TEXT NOT NULL,
	title TEXT NOT NULL,
	module_key TEXT NOT NULL,
	deps_json TEXT NOT NULL,
	input_text TEXT,
	output_text TEXT,
	accept_text TEXT,
	edge_ids_json TEXT,
	task_paths_json TEXT,
	contract_hash TEXT NOT NULL,
	is_contract_ready INTEGER NOT NULL DEFAULT 0 CHECK (is_contract_ready IN (0, 1)),
	contract_reasons_json TEXT NOT NULL,
	est_days REAL,
	batch_id TEXT REFERENCES batches(id),
	impl_prompt TEXT,
	review_prompt TEXT,
	is_removed_from_doc INTEGER NOT NULL DEFAULT 0 CHECK (is_removed_from_doc IN (0, 1)),
	has_accept_changed INTEGER NOT NULL DEFAULT 0 CHECK (has_accept_changed IN (0, 1)),
	has_prompt_changed INTEGER NOT NULL DEFAULT 0 CHECK (has_prompt_changed IN (0, 1)),
	manual_state TEXT,
	UNIQUE (doc_id, task_key)
);

CREATE INDEX tasks_batch_id_idx ON tasks(batch_id);

CREATE TABLE dispatch_snapshots (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id),
	input_text TEXT,
	output_text TEXT,
	accept_text TEXT,
	impl_prompt TEXT,
	review_prompt TEXT,
	contract_hash TEXT NOT NULL,
	task_paths_json TEXT NOT NULL,
	launch_spec_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX dispatch_snapshots_task_id_idx ON dispatch_snapshots(task_id);

CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	token_salt TEXT NOT NULL,
	paired_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	revoked_at TEXT
);

CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id),
	attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
	kind TEXT NOT NULL CHECK (kind IN ('implement', 'review')),
	parent_run_id TEXT REFERENCES runs(id),
	state TEXT NOT NULL CHECK (
		state IN (
			'queued',
			'starting',
			'running',
			'awaiting_reply',
			'exited',
			'reviewing',
			'reworking',
			'awaiting_human',
			'orphaned',
			'landed',
			'failed',
			'aborted',
			'interrupted'
		)
	),
	review_verdict TEXT CHECK (
		review_verdict IS NULL OR review_verdict IN ('pass', 'rework', 'doc_issue', 'incomplete')
	),
	agent_id TEXT NOT NULL,
	model_name TEXT,
	reported_model TEXT,
	effort_tier TEXT CHECK (effort_tier IS NULL OR effort_tier IN ('low', 'medium', 'high')),
	reported_effort TEXT,
	permission_tier TEXT NOT NULL CHECK (
		permission_tier IN ('readOnly', 'workspaceWrite', 'unrestricted')
	),
	snapshot_id TEXT NOT NULL REFERENCES dispatch_snapshots(id),
	worktree_path TEXT,
	branch_name TEXT,
	pid INTEGER,
	exit_code INTEGER,
	exit_signal TEXT,
	vendor_session_ref TEXT,
	changed_file_count INTEGER CHECK (changed_file_count IS NULL OR changed_file_count >= 0),
	token_usage_json TEXT,
	unmapped_event_count INTEGER NOT NULL DEFAULT 0 CHECK (unmapped_event_count >= 0),
	is_stall_suspected INTEGER NOT NULL DEFAULT 0 CHECK (is_stall_suspected IN (0, 1)),
	rework_count INTEGER NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
	queued_reason TEXT,
	idempotency_key TEXT UNIQUE,
	actor_device_id TEXT REFERENCES devices(id),
	started_at TEXT,
	last_event_at TEXT,
	ended_at TEXT,
	UNIQUE (task_id, attempt_no)
);

CREATE INDEX runs_state_idx ON runs(state);
CREATE INDEX runs_agent_id_state_idx ON runs(agent_id, state);
CREATE INDEX runs_last_event_at_idx ON runs(last_event_at);
CREATE INDEX runs_parent_run_id_idx ON runs(parent_run_id);

CREATE TABLE gates (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id),
	run_id TEXT REFERENCES runs(id),
	kind TEXT NOT NULL CHECK (kind IN ('dispatch', 'review', 'landing')),
	state TEXT NOT NULL CHECK (state IN ('waiting', 'decided')),
	decision TEXT CHECK (decision IS NULL OR decision IN ('pass', 'rework', 'reject')),
	comment TEXT,
	decided_by_device_id TEXT REFERENCES devices(id),
	created_at TEXT NOT NULL,
	decided_at TEXT
);

CREATE INDEX gates_task_id_idx ON gates(task_id);
CREATE INDEX gates_run_id_idx ON gates(run_id);

CREATE TABLE run_messages (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	kind TEXT NOT NULL CHECK (kind IN ('reply', 'approve', 'deny', 'elevate_once')),
	text TEXT,
	delivery_state TEXT NOT NULL CHECK (delivery_state IN ('delivered', 'undelivered')),
	undelivered_reason TEXT,
	actor_device_id TEXT REFERENCES devices(id),
	created_at TEXT NOT NULL,
	delivered_at TEXT
);

CREATE INDEX run_messages_run_id_idx ON run_messages(run_id);

CREATE TABLE events (
	id INTEGER PRIMARY KEY,
	run_id TEXT REFERENCES runs(id),
	task_id TEXT REFERENCES tasks(id),
	seq INTEGER NOT NULL CHECK (seq >= 0),
	ts TEXT NOT NULL,
	scope TEXT NOT NULL,
	kind TEXT NOT NULL,
	actor_device_id TEXT REFERENCES devices(id),
	file_seq INTEGER NOT NULL CHECK (file_seq >= 0),
	byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
	byte_len INTEGER NOT NULL CHECK (byte_len >= 0),
	UNIQUE (run_id, seq)
);

CREATE INDEX events_task_id_idx ON events(task_id);

CREATE TABLE log_segments (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	stream TEXT NOT NULL,
	file_seq INTEGER NOT NULL CHECK (file_seq >= 0),
	path TEXT NOT NULL,
	byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
	byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
	line_count INTEGER NOT NULL CHECK (line_count >= 0),
	UNIQUE (run_id, stream, file_seq)
);

CREATE TABLE event_seq (
	name TEXT PRIMARY KEY,
	watermark INTEGER NOT NULL CHECK (watermark >= 0)
);
