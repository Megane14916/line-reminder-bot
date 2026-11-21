ALTER TABLE task_conversation ADD COLUMN thread_id TEXT REFERENCES dialogue_threads(id) ON DELETE CASCADE;
ALTER TABLE task_conversation ADD COLUMN reply_text TEXT;
ALTER TABLE dialogue_threads ADD COLUMN selection_json TEXT;

UPDATE task_conversation AS c SET thread_id = (
  SELECT d.id FROM operation_result_outbox o JOIN dialogue_threads d ON d.id = o.thread_id
  WHERE o.event_id = c.event_id AND d.group_id = c.group_id AND d.user_id = c.user_id
);

CREATE INDEX task_conversation_thread_time ON task_conversation(thread_id, event_time);
