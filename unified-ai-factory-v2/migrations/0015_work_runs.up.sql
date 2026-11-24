-- Work runs (Dispatch v2.3): one model-driven attempt at a local-folder job, worked on a COPY of the project and applied only after a human approves
-- the exact diff. Additive. It does not use the job state machine: Dispatch does not run the orchestrator for these jobs.
CREATE TABLE work_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  status text NOT NULL CHECK (status IN ('running', 'awaiting_approval', 'applied', 'rejected', 'failed', 'cancelled')),
  plan jsonb NOT NULL,
  plan_digest text NOT NULL,
  workspace_path text NOT NULL,
  base_manifest jsonb NOT NULL,
  changes jsonb,
  changes_digest text,
  summary text,
  failure text,
  log jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('applied', 'rejected')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (status <> 'awaiting_approval' OR (changes IS NOT NULL AND changes_digest IS NOT NULL))
);
-- At most one live run per job.
CREATE UNIQUE INDEX work_runs_one_live_per_job ON work_runs (job_id) WHERE status IN ('running', 'awaiting_approval');
CREATE INDEX work_runs_job ON work_runs (job_id, created_at DESC);
