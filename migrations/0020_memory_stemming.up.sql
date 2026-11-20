-- Adaptive Memory v2.5, MEM-03 follow-up: stemmed lexical index. A claim is indexed under BOTH the English and the Portuguese
-- stemmers (their union), so 'exports', 'exporting', 'exportar' and 'exportações' share the stem 'export'. Queries are stemmed
-- the same two ways. Index version 2 replaces version 1 ('simple' configuration, no stemming). Rows are rebuilt here.
CREATE FUNCTION memory_lexical(claim text) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('english', claim) || to_tsvector('portuguese', claim)
$$;

CREATE OR REPLACE FUNCTION memory_index_maintain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    INSERT INTO memory_index (record_id, organization_id, project_id, indexed_claim_hash, index_version, lexical)
    VALUES (NEW.id, NEW.organization_id, NEW.project_id, NEW.normalized_claim_hash, 2, memory_lexical(NEW.claim))
    ON CONFLICT (record_id) DO UPDATE SET indexed_claim_hash = EXCLUDED.indexed_claim_hash,
      lexical = EXCLUDED.lexical, index_version = EXCLUDED.index_version, indexed_at = now();
  ELSE
    DELETE FROM memory_index WHERE record_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

UPDATE memory_index i SET lexical = memory_lexical(r.claim), index_version = 2, indexed_at = now()
  FROM memory_records r WHERE r.id = i.record_id;
