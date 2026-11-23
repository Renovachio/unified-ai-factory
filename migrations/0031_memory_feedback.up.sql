-- Adaptive Memory v2.5, MEM-06: retrieval feedback. Append-only. Stores a verdict and the state of the SAI-11 signal only: NO free
-- text, so feedback cannot carry instructions, and NO claim text. Feedback never changes a memory's status (no self-activation).
CREATE TABLE memory_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  memory_id uuid NOT NULL REFERENCES memory_records(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  verdict text NOT NULL CHECK (verdict IN ('useful', 'wrong', 'stale', 'missing')),
  signal_state text NOT NULL CHECK (signal_state IN ('not_requested', 'sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_feedback_memory ON memory_feedback (memory_id, created_at);
CREATE TRIGGER memory_feedback_append_only BEFORE UPDATE OR DELETE ON memory_feedback FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON memory_feedback TO factory_control;
