-- requires: foreign_keys=off

-- 1. Rebuild batches table with 7 states (idle, running, paused, awaiting_landing, wrapping, needs_attention, done)
CREATE TABLE new_batches (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
	batch_no INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'paused', 'awaiting_landing', 'wrapping', 'needs_attention', 'done')),
	started_at TEXT,
	finished_at TEXT,
	UNIQUE (doc_id, batch_no)
);

INSERT INTO new_batches (id, doc_id, batch_no, state, started_at, finished_at)
SELECT id, doc_id, batch_no, state, started_at, finished_at FROM batches;

DROP TABLE batches;
ALTER TABLE new_batches RENAME TO batches;

-- 2. Rebuild dispatch_snapshots table with nullable task_id and new batch_id
CREATE TABLE new_dispatch_snapshots (
	id TEXT PRIMARY KEY,
	task_id TEXT REFERENCES tasks(id),
	batch_id TEXT REFERENCES batches(id),
	input_text TEXT,
	output_text TEXT,
	accept_text TEXT,
	impl_prompt TEXT,
	review_prompt TEXT,
	bug_prompt TEXT,
	contract_hash TEXT NOT NULL,
	task_paths_json TEXT NOT NULL,
	launch_spec_json TEXT NOT NULL,
	assignment_json TEXT,
	parent_snapshot_id TEXT REFERENCES new_dispatch_snapshots(id),
	created_at TEXT NOT NULL,
	CHECK ((task_id IS NOT NULL) <> (batch_id IS NOT NULL))
);

INSERT INTO new_dispatch_snapshots (
	id,
	task_id,
	batch_id,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	assignment_json,
	parent_snapshot_id,
	created_at
)
SELECT
	id,
	task_id,
	NULL,
	input_text,
	output_text,
	accept_text,
	impl_prompt,
	review_prompt,
	bug_prompt,
	contract_hash,
	task_paths_json,
	launch_spec_json,
	NULL,
	NULL,
	created_at
FROM dispatch_snapshots;

DROP TABLE dispatch_snapshots;
ALTER TABLE new_dispatch_snapshots RENAME TO dispatch_snapshots;
CREATE INDEX dispatch_snapshots_task_id_idx ON dispatch_snapshots(task_id);
CREATE INDEX dispatch_snapshots_batch_id_idx ON dispatch_snapshots(batch_id);

-- 3. Rebuild gates table with nullable task_id
CREATE TABLE new_gates (
	id TEXT PRIMARY KEY,
	task_id TEXT REFERENCES tasks(id),
	run_id TEXT REFERENCES runs(id),
	kind TEXT NOT NULL CHECK (kind IN ('dispatch', 'review', 'landing')),
	state TEXT NOT NULL CHECK (state IN ('waiting', 'decided')),
	decision TEXT CHECK (decision IS NULL OR decision IN ('pass', 'rework', 'reject')),
	comment TEXT,
	decided_by_device_id TEXT REFERENCES devices(id),
	created_at TEXT NOT NULL,
	decided_at TEXT,
	CHECK (task_id IS NOT NULL OR run_id IS NOT NULL)
);

INSERT INTO new_gates (
	id,
	task_id,
	run_id,
	kind,
	state,
	decision,
	comment,
	decided_by_device_id,
	created_at,
	decided_at
)
SELECT
	id,
	task_id,
	run_id,
	kind,
	state,
	decision,
	comment,
	decided_by_device_id,
	created_at,
	decided_at
FROM gates;

DROP TABLE gates;
ALTER TABLE new_gates RENAME TO gates;
CREATE INDEX gates_task_id_idx ON gates(task_id);
CREATE INDEX gates_run_id_idx ON gates(run_id);

-- 4. Rebuild runs table with kind 4 values, nullable task_id, batch_id, is_in_head, etc.
CREATE TABLE new_runs (
	id TEXT PRIMARY KEY,
	task_id TEXT REFERENCES tasks(id),
	attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
	kind TEXT NOT NULL CHECK (kind IN ('implement', 'review', 'wrapup', 'bughunt')),
	parent_run_id TEXT REFERENCES new_runs(id),
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
	effort_vendor TEXT,
	lane_no INTEGER,
	session_archived_at TEXT,
	origin TEXT NOT NULL DEFAULT 'dispatch',
	spawned_by_run_id TEXT REFERENCES new_runs(id),
	review_round INTEGER,
	continued_from_run_id TEXT REFERENCES new_runs(id),
	batch_id TEXT REFERENCES batches(id),
	is_in_head INTEGER NOT NULL DEFAULT 0 CHECK (is_in_head IN (0, 1)),
	in_head_checked_at TEXT,
	branch_tip_sha TEXT,
	prompt_source TEXT CHECK (prompt_source IS NULL OR prompt_source IN ('docs', 'builtin')),
	assignment_source TEXT CHECK (assignment_source IS NULL OR assignment_source IN ('task', 'review_override', 'wrapup_settings', 'agent_default')),
	UNIQUE (task_id, attempt_no),
	CHECK ((kind = 'wrapup') = (task_id IS NULL))
);

INSERT INTO new_runs (
	id,
	task_id,
	attempt_no,
	kind,
	parent_run_id,
	state,
	review_verdict,
	agent_id,
	model_name,
	reported_model,
	effort_tier,
	reported_effort,
	permission_tier,
	snapshot_id,
	worktree_path,
	branch_name,
	pid,
	exit_code,
	exit_signal,
	vendor_session_ref,
	changed_file_count,
	token_usage_json,
	unmapped_event_count,
	is_stall_suspected,
	rework_count,
	queued_reason,
	idempotency_key,
	actor_device_id,
	started_at,
	last_event_at,
	ended_at,
	effort_vendor,
	lane_no,
	session_archived_at,
	origin,
	spawned_by_run_id,
	review_round,
	continued_from_run_id,
	batch_id,
	is_in_head,
	in_head_checked_at,
	branch_tip_sha,
	prompt_source,
	assignment_source
)
SELECT
	id,
	task_id,
	attempt_no,
	kind,
	parent_run_id,
	state,
	review_verdict,
	agent_id,
	model_name,
	reported_model,
	effort_tier,
	reported_effort,
	permission_tier,
	snapshot_id,
	worktree_path,
	branch_name,
	pid,
	exit_code,
	exit_signal,
	vendor_session_ref,
	changed_file_count,
	token_usage_json,
	unmapped_event_count,
	is_stall_suspected,
	rework_count,
	queued_reason,
	idempotency_key,
	actor_device_id,
	started_at,
	last_event_at,
	ended_at,
	effort_vendor,
	lane_no,
	session_archived_at,
	origin,
	spawned_by_run_id,
	review_round,
	continued_from_run_id,
	NULL,
	0,
	NULL,
	NULL,
	NULL,
	NULL
FROM runs;

DROP TABLE runs;
ALTER TABLE new_runs RENAME TO runs;

CREATE INDEX runs_state_idx ON runs(state);
CREATE INDEX runs_agent_id_state_idx ON runs(agent_id, state);
CREATE INDEX runs_last_event_at_idx ON runs(last_event_at);
CREATE INDEX runs_parent_run_id_idx ON runs(parent_run_id);
CREATE INDEX runs_parent_run_id_kind_idx ON runs(parent_run_id, kind);
CREATE INDEX runs_spawned_by_run_id_idx ON runs(spawned_by_run_id);
CREATE INDEX runs_batch_id_state_idx ON runs(batch_id, state);
CREATE INDEX runs_state_is_in_head_idx ON runs(state, is_in_head);
CREATE INDEX runs_task_kind_round_idx ON runs(task_id, kind, review_round);
CREATE INDEX runs_lane_no_idx ON runs(lane_no) WHERE lane_no IS NOT NULL;
CREATE UNIQUE INDEX ux_runs_continued ON runs(continued_from_run_id) WHERE continued_from_run_id IS NOT NULL;
CREATE UNIQUE INDEX ux_runs_wrapup_round ON runs(batch_id, attempt_no) WHERE kind = 'wrapup';

-- 5. Create batch_wrapups table
CREATE TABLE batch_wrapups (
	id TEXT PRIMARY KEY,
	batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
	batch_no INTEGER NOT NULL,
	tasks_json TEXT NOT NULL,
	round INTEGER NOT NULL CHECK (round >= 1),
	run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
	verdict TEXT NOT NULL CHECK (verdict IN ('clean', 'fixed', 'open')),
	declared_verdict TEXT CHECK (declared_verdict IS NULL OR declared_verdict IN ('clean', 'fixed', 'open')),
	is_human_verdict INTEGER NOT NULL DEFAULT 0 CHECK (is_human_verdict IN (0, 1)),
	prompt_source TEXT NOT NULL CHECK (prompt_source IN ('docs', 'builtin')),
	tests_json TEXT NOT NULL,
	summary_text TEXT NOT NULL,
	findings_json TEXT NOT NULL,
	unassigned_json TEXT NOT NULL,
	fix_run_ids_json TEXT NOT NULL,
	report_text TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE (batch_id, round, is_human_verdict)
);

CREATE INDEX batch_wrapups_batch_id_created_at_idx ON batch_wrapups(batch_id, created_at);
