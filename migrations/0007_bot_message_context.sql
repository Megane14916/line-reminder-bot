ALTER TABLE operation_result_outbox ADD COLUMN task_id INTEGER REFERENCES tasks(id);
ALTER TABLE operation_result_outbox ADD COLUMN line_message_id TEXT;

CREATE UNIQUE INDEX operation_results_quote ON operation_result_outbox(group_id, line_message_id)
  WHERE line_message_id IS NOT NULL;
