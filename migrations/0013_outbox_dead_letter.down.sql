-- Rollback: dead-lettered rows return to pending so nothing is lost.
UPDATE outbox SET status = 'pending', retry_after = NULL WHERE status = 'failed';
DROP INDEX IF EXISTS outbox_dead_idx;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_dead_has_time, DROP COLUMN last_error, DROP COLUMN dead_at;
