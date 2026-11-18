-- 0001_core: control-plane schema (blueprint section 9)
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  settings_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  auth_subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','editor','operator','approver','admin','security_officer')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, auth_subject)
);
CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('github')),
  external_id text NOT NULL,
  owner text NOT NULL,
  name text NOT NULL,
  base_branch text NOT NULL DEFAULT 'main',
  policy_id text,
  installation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL,
  external_id text NOT NULL,
  credentials_ref text,
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, external_id)
);
CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  source text NOT NULL,
  source_external_id text,
  payload_digest text NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED',
  requester_id uuid REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('feature','bug','maintenance','research')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 250),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, source, source_external_id)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES requests(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'INTAKE', 'NEEDS_INFO', 'SPECIFYING', 'READY', 'PROVISIONING', 'BUILDING', 'GATING', 'REVIEWING', 'REWORK', 'PREMERGE', 'AWAITING_HUMAN', 'MERGING', 'MERGED', 'POSTMERGE_MONITOR', 'DONE', 'REJECTED', 'CANCELLED', 'FAILED', 'QUARANTINED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  risk text NOT NULL DEFAULT 'CRITICAL' CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  policy_digest text,
  spec_digest text,
  base_sha text CHECK (base_sha ~ '^[a-f0-9]{40}$'),
  head_sha text CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  pr_number integer,
  current_round integer NOT NULL DEFAULT 0 CHECK (current_round >= 0),
  max_rounds integer NOT NULL DEFAULT 3 CHECK (max_rounds >= 0),
  paused_at timestamptz,
  pause_reason text,
  created_by uuid REFERENCES users(id),
  last_error_code text,
  event_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (paused_at IS NULL OR pause_reason IS NOT NULL)
);
CREATE INDEX jobs_state_created_idx ON jobs (state, created_at);
CREATE TABLE allowed_transitions (
  from_state text NOT NULL,
  to_state text NOT NULL,
  PRIMARY KEY (from_state, to_state)
);
INSERT INTO allowed_transitions (from_state, to_state) VALUES
  ('QUEUED','INTAKE'),
  ('QUEUED','CANCELLED'),
  ('INTAKE','NEEDS_INFO'),
  ('INTAKE','SPECIFYING'),
  ('INTAKE','REJECTED'),
  ('INTAKE','FAILED'),
  ('INTAKE','CANCELLED'),
  ('NEEDS_INFO','INTAKE'),
  ('NEEDS_INFO','CANCELLED'),
  ('NEEDS_INFO','REJECTED'),
  ('SPECIFYING','READY'),
  ('SPECIFYING','NEEDS_INFO'),
  ('SPECIFYING','FAILED'),
  ('SPECIFYING','CANCELLED'),
  ('READY','PROVISIONING'),
  ('READY','CANCELLED'),
  ('PROVISIONING','BUILDING'),
  ('PROVISIONING','FAILED'),
  ('PROVISIONING','QUARANTINED'),
  ('PROVISIONING','CANCELLED'),
  ('BUILDING','GATING'),
  ('BUILDING','REWORK'),
  ('BUILDING','FAILED'),
  ('BUILDING','QUARANTINED'),
  ('BUILDING','CANCELLED'),
  ('GATING','REVIEWING'),
  ('GATING','REWORK'),
  ('GATING','FAILED'),
  ('GATING','QUARANTINED'),
  ('GATING','CANCELLED'),
  ('REVIEWING','PREMERGE'),
  ('REVIEWING','REWORK'),
  ('REVIEWING','FAILED'),
  ('REVIEWING','QUARANTINED'),
  ('REVIEWING','CANCELLED'),
  ('REWORK','BUILDING'),
  ('REWORK','AWAITING_HUMAN'),
  ('REWORK','FAILED'),
  ('REWORK','CANCELLED'),
  ('PREMERGE','AWAITING_HUMAN'),
  ('PREMERGE','MERGING'),
  ('PREMERGE','REWORK'),
  ('PREMERGE','FAILED'),
  ('PREMERGE','QUARANTINED'),
  ('PREMERGE','CANCELLED'),
  ('AWAITING_HUMAN','PREMERGE'),
  ('AWAITING_HUMAN','REWORK'),
  ('AWAITING_HUMAN','REJECTED'),
  ('AWAITING_HUMAN','CANCELLED'),
  ('MERGING','MERGED'),
  ('MERGING','PREMERGE'),
  ('MERGING','FAILED'),
  ('MERGING','QUARANTINED'),
  ('MERGED','POSTMERGE_MONITOR'),
  ('POSTMERGE_MONITOR','DONE'),
  ('POSTMERGE_MONITOR','FAILED'),
  ('FAILED','QUEUED'),
  ('FAILED','REWORK'),
  ('FAILED','CANCELLED'),
  ('QUARANTINED','CANCELLED'),
  ('QUARANTINED','FAILED');
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE FUNCTION enforce_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT EXISTS (SELECT 1 FROM allowed_transitions WHERE from_state = OLD.state AND to_state = NEW.state) THEN
      RAISE EXCEPTION 'illegal job transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'job version must increase by exactly 1 on state change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.id <> OLD.id OR NEW.request_id <> OLD.request_id OR NEW.repository_id <> OLD.repository_id THEN
    RAISE EXCEPTION 'job identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_enforce_transition BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION enforce_job_transition();
CREATE TRIGGER allowed_transitions_immutable BEFORE UPDATE OR DELETE ON allowed_transitions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE job_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  version integer NOT NULL,
  actor_id text NOT NULL,
  evidence_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version),
  FOREIGN KEY (from_state, to_state) REFERENCES allowed_transitions (from_state, to_state)
);
CREATE TRIGGER job_transitions_append_only BEFORE UPDATE OR DELETE ON job_transitions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  mode text NOT NULL CHECK (mode IN ('local','cloud')),
  capability_json jsonb NOT NULL DEFAULT '{}',
  heartbeat_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','draining','quarantined','lost')),
  attestation jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE fencing_token_seq AS bigint START 1;
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  stage text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','running','succeeded','failed','cancelled','expired')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_owner uuid REFERENCES workers(id),
  lease_expiry timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  assigned_worker_id uuid REFERENCES workers(id),
  worktree_ref text,
  runtime_id text,
  model_id text,
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, stage, attempt, role),
  CHECK (status NOT IN ('leased','running') OR (lease_owner IS NOT NULL AND lease_expiry IS NOT NULL))
);
CREATE INDEX tasks_status_lease_idx ON tasks (status, lease_expiry);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  runtime_id text NOT NULL,
  model_id text NOT NULL,
  prompt_digest text NOT NULL,
  context_digest text NOT NULL,
  status text NOT NULL,
  auth_mode text NOT NULL CHECK (auth_mode IN ('subscription_cli','local_model')),
  inference_billing_mode text NOT NULL CHECK (inference_billing_mode IN ('subscription_included','local_compute')),
  token_input bigint,
  token_output bigint,
  compute_seconds double precision,
  usage_source text NOT NULL CHECK (usage_source IN ('cli_reported','local_runtime','estimated','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  run_id uuid REFERENCES agent_runs(id),
  kind text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  storage_uri text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  redaction_status text NOT NULL DEFAULT 'pending' CHECK (redaction_status IN ('pending','redacted','clean')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, kind, digest)
);
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OF digest, storage_uri, byte_length, job_id, kind ON artifacts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE gate_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  base_sha text NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
  gate_config_digest text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass','fail','error')),
  results_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, head_sha, base_sha, gate_config_digest)
);
CREATE TRIGGER gate_results_append_only BEFORE UPDATE OR DELETE ON gate_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE review_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('code','security','ux','ui','performance')),
  reviewer_run_id uuid REFERENCES agent_runs(id),
  verdict text NOT NULL CHECK (verdict IN ('pass','changes_requested','blocked')),
  findings_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, head_sha, reviewer_role, reviewer_run_id)
);
CREATE TRIGGER review_results_append_only BEFORE UPDATE OR DELETE ON review_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  policy_digest text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  eligible boolean NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT eligible OR risk IN ('LOW','MEDIUM'))
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  base_sha text NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
  policy_digest text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approve','reject','rework')),
  reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE merge_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  pr_number integer NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','failed','aborted')),
  github_merge_sha text CHECK (github_merge_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, pr_number, head_sha)
);
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_seq bigint GENERATED ALWAYS AS IDENTITY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  type text NOT NULL,
  source text NOT NULL,
  actor_id text,
  payload_redacted jsonb NOT NULL DEFAULT '{}',
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, sequence),
  UNIQUE (global_seq)
);
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  destination text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination, dedupe_key)
);
CREATE INDEX outbox_pending_idx ON outbox (status, retry_after);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  delivery_id text NOT NULL,
  signature_valid boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, delivery_id)
);
CREATE TABLE audit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  result text NOT NULL,
  reason text,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entries_org_time_idx ON audit_entries (organization_id, created_at);
CREATE TRIGGER audit_entries_append_only BEFORE UPDATE OR DELETE ON audit_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
