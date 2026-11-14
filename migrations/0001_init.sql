CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('deadline', 'belonging')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  due_date TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX tasks_group_status_due_date ON tasks (group_id, status, due_date);

CREATE TABLE interaction_sessions (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('idle', 'awaiting_input', 'confirm_create', 'confirm_delete')),
  token TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  processed_at INTEGER NOT NULL
);
