CREATE TABLE task_conversation (
  event_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id INTEGER,
  event_time INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  turn_json TEXT NOT NULL
);
CREATE INDEX task_conversation_actor_time ON task_conversation(group_id, user_id, event_time DESC);
CREATE INDEX task_conversation_expiry ON task_conversation(expires_at);
