ALTER TABLE tasks ADD COLUMN lane_no INTEGER;
ALTER TABLE runs ADD COLUMN lane_no INTEGER;
ALTER TABLE runs ADD COLUMN session_archived_at TEXT;

CREATE UNIQUE INDEX ux_tasks_lane ON tasks(doc_id, lane_no) WHERE lane_no IS NOT NULL;
CREATE INDEX runs_lane_no_idx ON runs(lane_no) WHERE lane_no IS NOT NULL;
