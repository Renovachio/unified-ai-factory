-- Adaptive Memory v2.5, MEM-06: project telemetry consent, set only by an approver. Append-only; the latest row (by seq) is the
-- current setting. No row means NOT opted in. Feedback and retries read this table; callers cannot assert consent.
CREATE TABLE memory_telemetry_consent (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  opted_in boolean NOT NULL,
  granted_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_telemetry_consent_project ON memory_telemetry_consent (organization_id, project_id, seq);
CREATE TRIGGER memory_telemetry_consent_append_only BEFORE UPDATE OR DELETE ON memory_telemetry_consent FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON memory_telemetry_consent TO factory_control;
