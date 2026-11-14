ALTER TABLE notification_batches ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_batches ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE notification_batches ADD COLUMN lease_until INTEGER;
ALTER TABLE notification_batches ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE notification_batches ADD COLUMN last_error_kind TEXT;

-- Older rows were reserved immediately before an attempted send.
UPDATE notification_batches SET
  attempt_count = 1,
  last_attempt_at = created_at,
  lease_until = CASE WHEN status = 'pending' THEN created_at + 120000 END,
  next_attempt_at = CASE WHEN status = 'failed' THEN CASE
    WHEN http_status = 429 THEN created_at + 900000
    WHEN http_status IS NULL OR http_status BETWEEN 500 AND 599 THEN created_at + 300000
  END END,
  last_error_kind = CASE
    WHEN status = 'pending' THEN 'unknown'
    WHEN status = 'failed' THEN CASE WHEN http_status IS NULL THEN 'network' ELSE 'http' END
  END;
