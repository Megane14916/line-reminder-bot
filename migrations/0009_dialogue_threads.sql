CREATE TABLE dialogue_threads (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  original_text TEXT NOT NULL,
  pending_json TEXT,
  focus_json TEXT,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dialogue_pending ON dialogue_threads(group_id, user_id, updated_at DESC) WHERE pending_json IS NOT NULL;
CREATE INDEX dialogue_expiry ON dialogue_threads(expires_at);

ALTER TABLE operation_result_outbox ADD COLUMN thread_id TEXT;
ALTER TABLE operation_result_outbox ADD COLUMN thread_question INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operation_result_outbox ADD COLUMN trigger_message_id TEXT;
