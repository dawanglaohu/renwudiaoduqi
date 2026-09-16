ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'dispatch';
ALTER TABLE runs ADD COLUMN spawned_by_run_id TEXT REFERENCES runs(id);

CREATE INDEX IF NOT EXISTS runs_spawned_by_run_id_idx ON runs(spawned_by_run_id);
