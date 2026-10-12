CREATE TABLE document_executions (
    doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'paused', 'completed')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    content_fingerprint TEXT,
    plan_json TEXT NOT NULL DEFAULT '[]',
    default_assignment_json TEXT,
    current_batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
    pause_reason TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

INSERT INTO document_executions (doc_id, updated_at)
SELECT id, imported_at FROM documents;

CREATE TRIGGER pause_document_execution_on_source_change
AFTER UPDATE OF content_fingerprint, is_source_readable, docs_path, repo_path ON documents
WHEN OLD.content_fingerprint <> NEW.content_fingerprint
  OR OLD.is_source_readable <> NEW.is_source_readable
  OR OLD.docs_path <> NEW.docs_path
  OR OLD.repo_path IS NOT NEW.repo_path
BEGIN
    UPDATE document_executions
    SET state = CASE
            WHEN state = 'completed' AND (
                OLD.content_fingerprint <> NEW.content_fingerprint
                OR OLD.docs_path <> NEW.docs_path
                OR OLD.repo_path IS NOT NEW.repo_path
            ) THEN 'idle'
            WHEN state = 'running' THEN 'paused'
            ELSE state
        END,
        version = version + 1,
        pause_reason = CASE
            WHEN NEW.is_source_readable = 0 THEN 'source_unreadable'
            WHEN OLD.content_fingerprint <> NEW.content_fingerprint
              OR OLD.docs_path <> NEW.docs_path
              OR OLD.repo_path IS NOT NEW.repo_path THEN 'doc_changed'
            ELSE pause_reason
        END,
        completed_at = CASE WHEN state = 'completed' AND (
            OLD.content_fingerprint <> NEW.content_fingerprint
            OR OLD.docs_path <> NEW.docs_path
            OR OLD.repo_path IS NOT NEW.repo_path
        ) THEN NULL ELSE completed_at END,
        updated_at = NEW.last_seen_at
    WHERE doc_id = NEW.id AND (
        state = 'running' OR state = 'completed' AND (
            OLD.content_fingerprint <> NEW.content_fingerprint
            OR OLD.docs_path <> NEW.docs_path
            OR OLD.repo_path IS NOT NEW.repo_path
        )
    );
END;
