-- 0012_improvement_loop (v2.2 SAI-03/04/09/10/11 + PM artifacts): qualifications, signals, proposals, benchmarks, paired comparisons, ledger.
-- The supervisor (factory_supervisor) may observe and propose; it can NOT write benchmarks, comparisons, qualifications, approvals or the active registry.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_evaluator') THEN CREATE ROLE factory_evaluator NOLOGIN; END IF;
END $$;

CREATE TABLE benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  version text NOT NULL,
  role text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  holdout_digest text NOT NULL CHECK (holdout_digest ~ '^sha256:[0-9a-f]{64}$'),
  grader_digest text NOT NULL CHECK (grader_digest ~ '^sha256:[0-9a-f]{64}$'),
  min_samples integer NOT NULL CHECK (min_samples >= 1),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name, version)
);
CREATE TRIGGER benchmarks_append_only BEFORE UPDATE OR DELETE ON benchmarks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE eval_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
  candidate_digest text NOT NULL,
  baseline_digest text NOT NULL,
  benchmark_digest text NOT NULL,
  policy_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','insufficient_evidence')),
  report jsonb NOT NULL,
  evaluator text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (candidate_digest <> baseline_digest)
);
CREATE TRIGGER eval_comparisons_append_only BEFORE UPDATE OR DELETE ON eval_comparisons FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE capability_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  version_id uuid NOT NULL REFERENCES skill_versions(id),
  role text NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('claude_code_cli','codex_cli','local_model')),
  comparison_id uuid NOT NULL REFERENCES eval_comparisons(id),
  score double precision NOT NULL CHECK (score BETWEEN 0 AND 1),
  sample_size integer NOT NULL CHECK (sample_size >= 1),
  approved_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION qualification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'qualifications are append-only'; END IF;
  IF TG_OP = 'UPDATE' AND ((NEW.id, NEW.version_id, NEW.role, NEW.runtime, NEW.comparison_id, NEW.score, NEW.sample_size, NEW.approved_by, NEW.expires_at) IS DISTINCT FROM (OLD.id, OLD.version_id, OLD.role, OLD.runtime, OLD.comparison_id, OLD.score, OLD.sample_size, OLD.approved_by, OLD.expires_at) OR OLD.revoked_at IS NOT NULL)
  THEN RAISE EXCEPTION 'qualifications are immutable (revocation only)'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qualification_guard BEFORE UPDATE OR DELETE ON capability_qualifications FOR EACH ROW EXECUTE FUNCTION qualification_guard();

-- Only anonymized, opted-in telemetry is stored; the constraint makes it impossible to insert a non-opted-in or non-anonymized signal.
CREATE TABLE improvement_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL DEFAULT 'default',
  kind text NOT NULL CHECK (kind IN ('uncovered_request','validation_failure','user_correction','low_quality','missing_tool','policy_refusal','regression','defect','rework')),
  target_version_id uuid REFERENCES skill_versions(id),
  intent_key text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  anonymized boolean NOT NULL CHECK (anonymized),
  opted_in boolean NOT NULL CHECK (opted_in),
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, kind, intent_key, evidence_digest)
);
CREATE TRIGGER improvement_signals_append_only BEFORE UPDATE OR DELETE ON improvement_signals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE improvement_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  dedupe_key text NOT NULL,
  target_digest text NOT NULL,
  signal_ids uuid[] NOT NULL CHECK (cardinality(signal_ids) >= 1),
  problem text NOT NULL,
  hypothesis text NOT NULL,
  requested_action text NOT NULL CHECK (requested_action IN ('create_skill','revise_skill','create_agent','revise_agent','revise_workflow','no_action')),
  risk text NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'observed' CHECK (state IN ('observed','triaged','planned','candidate_ready','evaluating','rejected','awaiting_approval','approved','monitoring','accepted','rolled_back','blocked')),
  candidate_digest text,
  comparison_id uuid REFERENCES eval_comparisons(id),
  rollback_rule text,
  rank_score double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
-- State machine for proposals; the supervisor identity can never push a proposal into an authority-bearing state.
CREATE FUNCTION improvement_proposals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'proposals are never deleted (evidence is preserved)'; END IF;
  IF (NEW.id, NEW.organization_id, NEW.dedupe_key, NEW.target_digest, NEW.signal_ids, NEW.problem, NEW.hypothesis, NEW.requested_action, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.dedupe_key, OLD.target_digest, OLD.signal_ids, OLD.problem, OLD.hypothesis, OLD.requested_action, OLD.created_at)
  THEN RAISE EXCEPTION 'proposal content is immutable'; END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT (
      (OLD.state = 'observed' AND NEW.state IN ('triaged','blocked','rejected')) OR
      (OLD.state = 'triaged' AND NEW.state IN ('planned','blocked','rejected')) OR
      (OLD.state = 'planned' AND NEW.state IN ('candidate_ready','blocked','rejected')) OR
      (OLD.state = 'candidate_ready' AND NEW.state IN ('evaluating','blocked','rejected')) OR
      (OLD.state = 'evaluating' AND NEW.state IN ('awaiting_approval','rejected','blocked')) OR
      (OLD.state = 'awaiting_approval' AND NEW.state IN ('approved','rejected','blocked')) OR
      (OLD.state = 'approved' AND NEW.state = 'monitoring') OR
      (OLD.state = 'monitoring' AND NEW.state IN ('accepted','rolled_back'))
    ) THEN RAISE EXCEPTION 'illegal proposal transition % -> %', OLD.state, NEW.state; END IF;
    IF NEW.state IN ('approved','monitoring','accepted') AND current_user = 'factory_supervisor' THEN RAISE EXCEPTION 'the supervisor identity cannot approve or promote'; END IF;
    IF NEW.state = 'awaiting_approval' AND (NEW.candidate_digest IS NULL OR NEW.comparison_id IS NULL OR NEW.rollback_rule IS NULL) THEN RAISE EXCEPTION 'approval package needs candidate, comparison and rollback rule'; END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER improvement_proposals_guard BEFORE UPDATE OR DELETE ON improvement_proposals FOR EACH ROW EXECUTE FUNCTION improvement_proposals_guard();

CREATE TABLE experiment_ledger (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  proposal_id uuid NOT NULL REFERENCES improvement_proposals(id),
  event text NOT NULL,
  benchmark_digest text,
  evaluator text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER experiment_ledger_append_only BEFORE UPDATE OR DELETE ON experiment_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE product_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL DEFAULT 'default',
  kind text NOT NULL CHECK (kind IN ('meeting','research','prd','epic','story','roadmap','analytics','decision','action')),
  title text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','in_review','approved','superseded','rejected')),
  source_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  body jsonb NOT NULL,
  digest text NOT NULL,
  assumptions text[] NOT NULL DEFAULT ARRAY[]::text[],
  open_questions text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, kind, title, version),
  CHECK (state <> 'approved' OR (approved_by IS NOT NULL AND approved_by <> created_by)),
  CHECK (kind IN ('decision','action') OR cardinality(source_ids) >= 1 OR state = 'draft')
);
-- Approved/superseded versions are immutable; an LLM summary is a draft until an independent human approves that exact digest.
CREATE FUNCTION product_artifacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'product artifacts are never deleted'; END IF;
  IF OLD.state IN ('approved','superseded','rejected') AND NOT (OLD.state = 'approved' AND NEW.state = 'superseded' AND (NEW.body, NEW.digest, NEW.title, NEW.version) IS NOT DISTINCT FROM (OLD.body, OLD.digest, OLD.title, OLD.version)) THEN RAISE EXCEPTION 'approved artifact versions are immutable'; END IF;
  IF (NEW.id, NEW.kind, NEW.version, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.kind, OLD.version, OLD.created_by, OLD.created_at) THEN RAISE EXCEPTION 'artifact identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_artifacts_guard BEFORE UPDATE OR DELETE ON product_artifacts FOR EACH ROW EXECUTE FUNCTION product_artifacts_guard();

-- Grants. Supervisor: read everything it needs; write only signals, proposals (non-authority states) and the ledger.
REVOKE ALL ON benchmarks, eval_comparisons, capability_qualifications, improvement_signals, improvement_proposals, experiment_ledger, product_artifacts FROM factory_runner, factory_merge, factory_supervisor, factory_evaluator;
GRANT USAGE ON SCHEMA public TO factory_evaluator;
GRANT SELECT ON benchmarks, eval_comparisons, capability_qualifications, improvement_signals, improvement_proposals, experiment_ledger, product_artifacts TO factory_supervisor;
GRANT INSERT ON improvement_signals, improvement_proposals, experiment_ledger TO factory_supervisor;
GRANT UPDATE ON improvement_proposals TO factory_supervisor;
GRANT USAGE ON SEQUENCE experiment_ledger_id_seq TO factory_supervisor, factory_control, factory_evaluator;
GRANT SELECT ON skill_versions, registry_active, benchmarks TO factory_evaluator;
GRANT SELECT, INSERT ON eval_comparisons TO factory_evaluator;
GRANT SELECT ON improvement_proposals TO factory_evaluator;
GRANT INSERT ON experiment_ledger TO factory_evaluator;
GRANT SELECT, INSERT ON benchmarks, eval_comparisons, capability_qualifications, improvement_signals, experiment_ledger, product_artifacts TO factory_control;
GRANT SELECT, INSERT, UPDATE ON improvement_proposals TO factory_control;
GRANT UPDATE ON capability_qualifications, product_artifacts TO factory_control;
GRANT SELECT ON capability_qualifications TO factory_runner;
