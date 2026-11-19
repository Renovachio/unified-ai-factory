-- 0002_idempotency: request idempotency records and lookup indexes (additive).
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  route text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, route, idempotency_key)
);
CREATE INDEX jobs_repository_state_idx ON jobs (repository_id, state);
CREATE INDEX tasks_job_idx ON tasks (job_id);
