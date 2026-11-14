CREATE TABLE notification_batches (
  group_id TEXT NOT NULL,
  target_due_date TEXT NOT NULL,
  message_text TEXT NOT NULL,
  retry_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  http_status INTEGER,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, target_due_date)
);

CREATE INDEX tasks_open_due_date_group ON tasks (due_date, group_id) WHERE status = 'open';
