-- runs.prompt_source 由 0007_rebuild_tables_for_wrapup.sql 预置
CREATE INDEX IF NOT EXISTS runs_parent_run_id_kind_idx ON runs(parent_run_id, kind);
