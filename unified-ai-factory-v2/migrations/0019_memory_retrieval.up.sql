-- Adaptive Memory v2.5, MEM-03: lexical (full-text) index over APPROVED memories and an append-only retrieval log.
-- The index is a rebuildable projection of memory_records. A trigger keeps it in step with status, so an unapproved,
-- superseded, revoked or erased memory has no index row even if application code is bypassed.
-- Semantic (vector) retrieval is NOT present: pgvector is not installed or qualified in this repository.

CREATE TABLE memory_index (
  record_id uuid PRIMARY KEY REFERENCES memory_records(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  -- Digest of the claim the row was built from. Retrieval refuses a row whose hash no longer matches the record (stale).
  indexed_claim_hash text NOT NULL,
  index_version integer NOT NULL DEFAULT 1 CHECK (index_version >= 1),
  lexical tsvector NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_index_lexical_gin ON memory_index USING gin (lexical);
CREATE INDEX memory_index_scope_idx ON memory_index (organization_id, project_id);

CREATE FUNCTION memory_index_maintain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    INSERT INTO memory_index (record_id, organization_id, project_id, indexed_claim_hash, index_version, lexical)
    VALUES (NEW.id, NEW.organization_id, NEW.project_id, NEW.normalized_claim_hash, 1, to_tsvector('simple', NEW.claim))
    ON CONFLICT (record_id) DO UPDATE SET indexed_claim_hash = EXCLUDED.indexed_claim_hash,
      lexical = EXCLUDED.lexical, index_version = EXCLUDED.index_version, indexed_at = now();
  ELSE
    -- Index invalidation is immediate: anything that leaves 'approved' disappears from search.
    DELETE FROM memory_index WHERE record_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memory_index_maintain AFTER UPDATE OF status ON memory_records
  FOR EACH ROW EXECUTE FUNCTION memory_index_maintain();

-- Append-only record of each retrieval: who, which project, a DIGEST of the query (never the query text), what was returned.
CREATE TABLE memory_retrieval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  query_digest text NOT NULL CHECK (query_digest ~ '^sha256:[0-9a-f]{64}$'),
  retrieval_mode text NOT NULL CHECK (retrieval_mode IN ('lexical')),
  returned_ids uuid[] NOT NULL,
  omitted jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_retrieval_events_scope_idx ON memory_retrieval_events (organization_id, project_id, created_at);

CREATE FUNCTION memory_retrieval_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory_retrieval_events is append-only';
END $$;
CREATE TRIGGER memory_retrieval_events_append_only BEFORE UPDATE OR DELETE ON memory_retrieval_events
  FOR EACH ROW EXECUTE FUNCTION memory_retrieval_events_append_only();

-- The index trigger runs with the privileges of the role that changes status, so the control role needs index DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_index TO factory_control;
GRANT SELECT, INSERT ON memory_retrieval_events TO factory_control;
