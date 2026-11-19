-- 0006_candidates: immutable record of every candidate commit the factory produced (evidence is bound to these SHAs).
CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  round integer NOT NULL CHECK (round >= 0),
  role text NOT NULL CHECK (role IN ('builder','tester')),
  parent_sha text NOT NULL CHECK (parent_sha ~ '^[a-f0-9]{40}$'),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[a-f0-9]{40}$'),
  patch_digest text NOT NULL CHECK (patch_digest ~ '^sha256:[a-f0-9]{64}$'),
  descriptor_digest text NOT NULL CHECK (descriptor_digest ~ '^sha256:[a-f0-9]{64}$'),
  files_changed integer NOT NULL CHECK (files_changed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, round, role),
  UNIQUE (job_id, head_sha)
);
CREATE INDEX candidates_job_round_idx ON candidates (job_id, round);
CREATE TRIGGER candidates_append_only BEFORE UPDATE OR DELETE ON candidates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
