-- 0004_pull_requests: one PR per job (idempotent PR creation mapping).
CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  pr_number integer NOT NULL CHECK (pr_number > 0),
  head_ref text NOT NULL CHECK (head_ref ~ '^factory/[A-Za-z0-9_-]{1,80}$'),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  base_ref text NOT NULL,
  draft boolean NOT NULL DEFAULT true,
  html_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, pr_number)
);
