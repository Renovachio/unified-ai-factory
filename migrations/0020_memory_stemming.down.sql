-- Rollback of 0020: restore the unstemmed version-1 index. The index is a projection, so rows are rebuilt here.
CREATE OR REPLACE FUNCTION memory_index_maintain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    INSERT INTO memory_index (record_id, organization_id, project_id, indexed_claim_hash, index_version, lexical)
    VALUES (NEW.id, NEW.organization_id, NEW.project_id, NEW.normalized_claim_hash, 1, to_tsvector('simple', NEW.claim))
    ON CONFLICT (record_id) DO UPDATE SET indexed_claim_hash = EXCLUDED.indexed_claim_hash,
      lexical = EXCLUDED.lexical, index_version = EXCLUDED.index_version, indexed_at = now();
  ELSE
    DELETE FROM memory_index WHERE record_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
UPDATE memory_index i SET lexical = to_tsvector('simple', r.claim), index_version = 1, indexed_at = now()
  FROM memory_records r WHERE r.id = i.record_id;
DROP FUNCTION IF EXISTS memory_lexical(text);
