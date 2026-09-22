-- requires: foreign_keys=off
-- M8-T6 E-288：同一轮收口允许「机器裁定 + 人工裁定」各一行且都挂在同一条收口运行上，
-- 0007 把 run_id 设成 UNIQUE 后人工 pass 撞唯一约束返回 500。放宽为 UNIQUE (run_id, is_human_verdict)。
-- SQLite 无法单独删掉表级 UNIQUE，按 12 步法重建；FK 到 batches / runs 保持不变。
CREATE TABLE new_batch_wrapups (
	id TEXT PRIMARY KEY,
	batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
	batch_no INTEGER NOT NULL,
	tasks_json TEXT NOT NULL,
	round INTEGER NOT NULL CHECK (round >= 1),
	run_id TEXT NOT NULL REFERENCES runs(id),
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
	UNIQUE (batch_id, round, is_human_verdict),
	UNIQUE (run_id, is_human_verdict)
);

INSERT INTO new_batch_wrapups (
	id, batch_id, batch_no, tasks_json, round, run_id, verdict, declared_verdict, is_human_verdict,
	prompt_source, tests_json, summary_text, findings_json, unassigned_json, fix_run_ids_json,
	report_text, created_at
)
SELECT
	id, batch_id, batch_no, tasks_json, round, run_id, verdict, declared_verdict, is_human_verdict,
	prompt_source, tests_json, summary_text, findings_json, unassigned_json, fix_run_ids_json,
	report_text, created_at
FROM batch_wrapups;

DROP TABLE batch_wrapups;
ALTER TABLE new_batch_wrapups RENAME TO batch_wrapups;

CREATE INDEX batch_wrapups_batch_id_created_at_idx ON batch_wrapups(batch_id, created_at);
