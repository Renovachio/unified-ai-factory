-- Adaptive Memory v2.5, MEM-04: immutable context-pack evidence. A pack records which approved memories were selected,
-- at which version and stage, the budget accounting and the retrieval event it came from. The rendered text is NOT stored:
-- it is reproducible from the manifest and is handed to the caller once. Append-only.

CREATE TABLE context_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  model_role text NOT NULL CHECK (char_length(model_role) BETWEEN 1 AND 40),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens > 0),
  estimated_tokens integer NOT NULL CHECK (estimated_tokens >= 0),
  -- The budget invariant is also a database rule: no stored pack can claim to exceed its input budget.
  CONSTRAINT context_pack_within_budget CHECK (estimated_tokens <= max_input_tokens),
  retrieval_event_id uuid NOT NULL REFERENCES memory_retrieval_events(id),
  manifest jsonb NOT NULL,
  pack_digest text NOT NULL CHECK (pack_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_packs_scope_idx ON context_packs (organization_id, project_id, created_at);

CREATE FUNCTION context_packs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'context_packs is append-only';
END $$;
CREATE TRIGGER context_packs_append_only BEFORE UPDATE OR DELETE ON context_packs
  FOR EACH ROW EXECUTE FUNCTION context_packs_append_only();

GRANT SELECT, INSERT ON context_packs TO factory_control;
