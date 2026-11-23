-- Adaptive Memory v2.5, MEM-06 review fixes.
-- 1. The control role can write consent: it needs the sequence behind the append-only table.
-- 2. The database, not only application code, enforces who may set consent: the granting user must be an enabled approver or admin
--    of the same organization, and the project must belong to that organization (same rule as approvals_actor_guard, 0030).
-- 3. A retry must point at a feedback row of the SAME project and memory (composite key), so retries cannot cross projects.
GRANT USAGE ON SEQUENCE memory_telemetry_consent_seq_seq TO factory_control;

CREATE FUNCTION memory_consent_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.granted_by AND u.organization_id = NEW.organization_id
                   AND u.disabled_at IS NULL AND u.role IN ('approver', 'admin')) THEN
    RAISE EXCEPTION 'consent for project % must be set by an enabled approver or admin of its organization', NEW.project_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM repositories r WHERE r.id = NEW.project_id AND r.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'project % does not belong to organization %', NEW.project_id, NEW.organization_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_telemetry_consent_actor_guard BEFORE INSERT ON memory_telemetry_consent FOR EACH ROW EXECUTE FUNCTION memory_consent_actor_guard();

ALTER TABLE memory_feedback ADD CONSTRAINT memory_feedback_scope_key UNIQUE (id, project_id, memory_id);
ALTER TABLE memory_feedback ADD CONSTRAINT memory_feedback_retry_same_scope FOREIGN KEY (retry_of, project_id, memory_id)
  REFERENCES memory_feedback (id, project_id, memory_id);
