CREATE TABLE webhook_inbox (
  receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  input_json TEXT,
  action_json TEXT,
  reply_token TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  finished_at INTEGER
);

CREATE INDEX webhook_inbox_group_order ON webhook_inbox(group_id, event_time, receipt_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX webhook_inbox_available ON webhook_inbox(available_at, receipt_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE webhook_group_progress (
  group_id TEXT PRIMARY KEY NOT NULL,
  event_time INTEGER NOT NULL,
  receipt_id INTEGER NOT NULL
);
