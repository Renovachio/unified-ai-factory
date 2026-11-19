-- 0011_skill_registry (v2.2 SAI-08): immutable, content-addressed skill/agent versions; digest-bound approvals; CAS activation; append-only activation log.
-- Everything is INACTIVE by default: no row can become active without an independent human approval decision.
CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL DEFAULT 'default',
  kind text NOT NULL CHECK (kind IN ('skill','agent')),
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{2,63}$'),
  version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  permission_digest text NOT NULL CHECK (permission_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  origin jsonb NOT NULL,
  file_manifest jsonb NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'quarantined' CHECK (state IN ('quarantined','validated','awaiting_approval','approved','rejected','revoked')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, kind, slug, digest)
);
-- Content columns are immutable; only `state` may move, along allowed edges. Rows are never deleted.
CREATE FUNCTION skill_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'skill_versions rows are immutable and cannot be deleted'; END IF;
  IF (NEW.id, NEW.organization_id, NEW.workspace_id, NEW.kind, NEW.slug, NEW.version, NEW.digest, NEW.permission_digest, NEW.manifest, NEW.origin, NEW.file_manifest, NEW.meta, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.workspace_id, OLD.kind, OLD.slug, OLD.version, OLD.digest, OLD.permission_digest, OLD.manifest, OLD.origin, OLD.file_manifest, OLD.meta, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'skill version content is immutable'; END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'quarantined' AND NEW.state IN ('validated','rejected')) OR
       (OLD.state = 'validated' AND NEW.state IN ('awaiting_approval','rejected')) OR
       (OLD.state = 'awaiting_approval' AND NEW.state IN ('approved','rejected','validated')) OR
       (OLD.state = 'approved' AND NEW.state = 'revoked'))
  THEN RAISE EXCEPTION 'illegal skill version state transition % -> %', OLD.state, NEW.state; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_versions_guard BEFORE UPDATE OR DELETE ON skill_versions FOR EACH ROW EXECUTE FUNCTION skill_versions_guard();

CREATE TABLE skill_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES skill_versions(id),
  candidate_digest text NOT NULL,
  policy_digest text NOT NULL,
  ok boolean NOT NULL,
  report jsonb NOT NULL,
  signature text NOT NULL,
  key_id text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER skill_validations_append_only BEFORE UPDATE OR DELETE ON skill_validations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  version_id uuid NOT NULL REFERENCES skill_versions(id),
  operation text NOT NULL CHECK (operation IN ('activate','upgrade','revoke','rollback','grant_permission')),
  target_digest text NOT NULL,
  permission_digest text NOT NULL,
  policy_digest text NOT NULL,
  evidence_digest text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE TRIGGER approval_requests_append_only BEFORE UPDATE OR DELETE ON approval_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A decision is a separate append-only fact, written only by the control plane on behalf of an authenticated human approver.
CREATE TABLE approval_decisions (
  request_id uuid PRIMARY KEY REFERENCES approval_requests(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by uuid NOT NULL REFERENCES users(id),
  presented_digest text NOT NULL,
  presented_permission_digest text NOT NULL,
  note text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE FUNCTION approval_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r approval_requests; v skill_versions; u users;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approval decisions cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.request_id, NEW.decision, NEW.decided_by, NEW.presented_digest, NEW.presented_permission_digest, NEW.decided_at) IS DISTINCT FROM (OLD.request_id, OLD.decision, OLD.decided_by, OLD.presented_digest, OLD.presented_permission_digest, OLD.decided_at)
       OR OLD.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'approval decisions are immutable (only first-time consumption is allowed)'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM approval_requests WHERE id = NEW.request_id;
  SELECT * INTO v FROM skill_versions WHERE id = r.version_id;
  SELECT * INTO u FROM users WHERE id = NEW.decided_by;
  IF u.disabled_at IS NOT NULL OR u.organization_id <> r.organization_id OR u.role NOT IN ('approver','admin','security_officer') THEN RAISE EXCEPTION 'decider is not an enabled approver of this organization'; END IF;
  IF NEW.decided_by = r.requested_by THEN RAISE EXCEPTION 'self-approval is forbidden (requester cannot decide)'; END IF;
  IF NEW.decided_by = v.created_by THEN RAISE EXCEPTION 'conflict of interest: the package author cannot approve it'; END IF;
  IF NEW.decision = 'approved' AND (NEW.presented_digest <> r.target_digest OR NEW.presented_permission_digest <> r.permission_digest) THEN RAISE EXCEPTION 'approval must name the exact content and permission digests'; END IF;
  IF now() >= r.expires_at THEN RAISE EXCEPTION 'approval request expired'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decisions_guard BEFORE INSERT OR UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION approval_decisions_guard();

-- One pointer per (org, workspace, kind, slug); `revision` is the compare-and-swap token.
CREATE TABLE registry_active (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL DEFAULT 'default',
  kind text NOT NULL CHECK (kind IN ('skill','agent')),
  slug text NOT NULL,
  active_version_id uuid REFERENCES skill_versions(id),
  revision integer NOT NULL DEFAULT 0,
  disabled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, kind, slug)
);
CREATE TABLE registry_log (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL,
  kind text NOT NULL,
  slug text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('activate','upgrade','rollback','revoke','emergency_disable','policy_disable','policy_rollback')),
  from_version_id uuid REFERENCES skill_versions(id),
  to_version_id uuid REFERENCES skill_versions(id),
  revision integer NOT NULL,
  approval_request_id uuid REFERENCES approval_requests(id),
  actor text NOT NULL,
  idempotency_key text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE TRIGGER registry_log_append_only BEFORE UPDATE OR DELETE ON registry_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Jobs pin the exact approved version they started with; a later activation never changes a running job.
CREATE TABLE job_skill_pins (
  job_id uuid NOT NULL REFERENCES jobs(id),
  version_id uuid NOT NULL REFERENCES skill_versions(id),
  digest text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, version_id)
);
CREATE TRIGGER job_skill_pins_append_only BEFORE UPDATE OR DELETE ON job_skill_pins FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Predeclared, human-approved disable/rollback rules; the supervisor may only EXECUTE a matching rule, never invent one.
CREATE TABLE rollback_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  version_id uuid NOT NULL REFERENCES skill_versions(id),
  metric text NOT NULL,
  comparator text NOT NULL CHECK (comparator IN ('lt','gt')),
  threshold double precision NOT NULL,
  min_samples integer NOT NULL CHECK (min_samples >= 1),
  action text NOT NULL CHECK (action IN ('disable','rollback')),
  approved_by uuid NOT NULL REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by <> created_by)
);
CREATE TRIGGER rollback_policies_append_only BEFORE UPDATE OR DELETE ON rollback_policies FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Privilege separation: supervisor identity is a distinct NOLOGIN role with NO approval, activation, policy or benchmark-write rights.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_supervisor') THEN CREATE ROLE factory_supervisor NOLOGIN; END IF;
END $$;
REVOKE ALL ON skill_versions, skill_validations, approval_requests, approval_decisions, registry_active, registry_log, job_skill_pins, rollback_policies FROM factory_runner, factory_merge, factory_supervisor;
GRANT USAGE ON SCHEMA public TO factory_supervisor;
GRANT SELECT ON skill_versions, skill_validations, approval_requests, approval_decisions, registry_active, registry_log, job_skill_pins, rollback_policies TO factory_supervisor;
GRANT SELECT ON skill_versions, registry_active, job_skill_pins TO factory_runner;
GRANT INSERT ON job_skill_pins TO factory_runner;
GRANT SELECT, INSERT, UPDATE ON skill_versions, registry_active TO factory_control;
GRANT SELECT, INSERT ON skill_validations, approval_requests, approval_decisions, registry_log, job_skill_pins, rollback_policies TO factory_control;
GRANT UPDATE (consumed_at) ON approval_decisions TO factory_control;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO factory_control;

-- The ONLY write path the supervisor has to the active registry: a deterministic, pre-approved, disable-only (never enable) action.
CREATE FUNCTION registry_policy_disable(p_policy uuid, p_observed double precision, p_samples integer, p_key text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pol rollback_policies; v skill_versions; act registry_active; breached boolean; rev integer;
BEGIN
  SELECT * INTO pol FROM rollback_policies WHERE id = p_policy;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such rollback policy'; END IF;
  IF p_samples < pol.min_samples THEN RAISE EXCEPTION 'not enough samples for policy (% < %)', p_samples, pol.min_samples; END IF;
  breached := CASE pol.comparator WHEN 'lt' THEN p_observed < pol.threshold ELSE p_observed > pol.threshold END;
  IF NOT breached THEN RAISE EXCEPTION 'policy threshold not breached'; END IF;
  SELECT * INTO v FROM skill_versions WHERE id = pol.version_id;
  SELECT * INTO act FROM registry_active WHERE organization_id = v.organization_id AND workspace_id = v.workspace_id AND kind = v.kind AND slug = v.slug FOR UPDATE;
  IF NOT FOUND OR act.active_version_id IS DISTINCT FROM v.id THEN RAISE EXCEPTION 'policy target is not the active version'; END IF;
  rev := act.revision + 1;
  UPDATE registry_active SET active_version_id = NULL, revision = rev, disabled_reason = 'policy ' || p_policy::text, updated_at = now() WHERE organization_id = act.organization_id AND workspace_id = act.workspace_id AND kind = act.kind AND slug = act.slug;
  INSERT INTO registry_log (organization_id, workspace_id, kind, slug, operation, from_version_id, to_version_id, revision, actor, idempotency_key, reason)
    VALUES (v.organization_id, v.workspace_id, v.kind, v.slug, 'policy_disable', v.id, NULL, rev, 'supervisor', p_key, format('metric %s=%s over %s samples breached %s %s', pol.metric, p_observed, p_samples, pol.comparator, pol.threshold));
  RETURN rev;
END $$;
REVOKE ALL ON FUNCTION registry_policy_disable(uuid, double precision, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry_policy_disable(uuid, double precision, integer, text) TO factory_supervisor, factory_control;
