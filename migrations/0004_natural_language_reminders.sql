ALTER TABLE tasks ADD COLUMN deleted_at INTEGER;
ALTER TABLE tasks ADD COLUMN reminder_rule TEXT NOT NULL DEFAULT '{"type":"default"}';
ALTER TABLE tasks ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN reminder_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN reminder_anchor INTEGER;
ALTER TABLE tasks ADD COLUMN next_reminder_at INTEGER;

-- The scheduler initializes old open tasks using their original registration date.
UPDATE tasks SET reminder_anchor = created_at, next_reminder_at = 0 WHERE status = 'open';
CREATE INDEX tasks_next_reminder ON tasks(next_reminder_at) WHERE status = 'open' AND deleted_at IS NULL AND reminder_enabled = 1;

CREATE TABLE group_reminder_defaults (
  group_id TEXT PRIMARY KEY NOT NULL,
  rule_json TEXT NOT NULL
);

CREATE TABLE task_contexts (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id INTEGER,
  operation TEXT NOT NULL,
  pending_json TEXT,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE reminder_occurrences (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  scheduled_at INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  message_text TEXT NOT NULL,
  retry_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  last_error_kind TEXT,
  http_status INTEGER,
  sent_at INTEGER,
  line_message_id TEXT,
  PRIMARY KEY (task_id, scheduled_at)
);

CREATE INDEX reminder_occurrences_pending ON reminder_occurrences(scheduled_at) WHERE status != 'sent';
CREATE UNIQUE INDEX reminder_occurrences_quote ON reminder_occurrences(group_id, line_message_id) WHERE line_message_id IS NOT NULL;
