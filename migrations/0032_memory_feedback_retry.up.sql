-- Adaptive Memory v2.5, MEM-06: a retry of a failed gap signal is a NEW append-only row that points at the row it retries.
-- A failed row is never updated; it is retried at most once (enforced in code and by the unique index below).
ALTER TABLE memory_feedback ADD COLUMN retry_of uuid REFERENCES memory_feedback(id);
CREATE UNIQUE INDEX memory_feedback_one_retry ON memory_feedback (retry_of) WHERE retry_of IS NOT NULL;
