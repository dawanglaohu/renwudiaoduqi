ALTER TABLE runs ADD COLUMN review_round INTEGER;
ALTER TABLE runs ADD COLUMN continued_from_run_id TEXT REFERENCES runs(id);

CREATE UNIQUE INDEX ux_runs_continued ON runs(continued_from_run_id) WHERE continued_from_run_id IS NOT NULL;
CREATE INDEX ix_runs_task_kind_round ON runs(task_id, kind, review_round);
