-- 0013_outbox_dead_letter (ACT-07): poisoned outbox rows stop retrying forever. After max attempts a row is moved to status 'failed' (dead letter) with the last error, and stays visible to operators until requeued.
ALTER TABLE outbox ADD COLUMN last_error text, ADD COLUMN dead_at timestamptz;
ALTER TABLE outbox ADD CONSTRAINT outbox_dead_has_time CHECK (status <> 'failed' OR dead_at IS NOT NULL);
CREATE INDEX outbox_dead_idx ON outbox (dead_at) WHERE status = 'failed';
