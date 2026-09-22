ALTER TABLE ai_sessions ADD COLUMN pid INTEGER;
ALTER TABLE ai_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE ai_sessions ADD COLUMN branch TEXT;
ALTER TABLE ai_sessions ADD COLUMN error TEXT;
CREATE INDEX ai_session_activity_idx ON ai_sessions(last_active_at DESC);
CREATE INDEX audit_session_idx ON audit_events(ai_session_id, created_at DESC);
CREATE UNIQUE INDEX ai_remote_session_idx ON ai_sessions(opencode_session_id) WHERE opencode_session_id IS NOT NULL;
CREATE TABLE ai_messages (
    session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(session_id, message_id)
);
