CREATE TABLE operation_result_outbox (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES webhook_inbox(event_id),
  group_id TEXT NOT NULL,
  text TEXT,
  reply_token TEXT,
  reply_until INTEGER NOT NULL,
  retry_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reply_pending', 'replying', 'push_pending', 'pushing', 'sent', 'failed', 'uncertain')),
  channel TEXT CHECK (channel IN ('reply', 'push')),
  push_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  finished_at INTEGER
);

CREATE INDEX operation_result_outbox_available ON operation_result_outbox(available_at, expires_at)
  WHERE status IN ('reply_pending', 'replying', 'push_pending', 'pushing');
