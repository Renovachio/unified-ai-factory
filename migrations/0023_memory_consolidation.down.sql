-- Rollback of 0023. Consolidation lineage is audit history: refuse while any link exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memory_consolidations) THEN
    RAISE EXCEPTION 'cannot roll back 0023: consolidation lineage exists and is audit history';
  END IF;
END $$;
DROP TRIGGER IF EXISTS memory_consolidations_append_only ON memory_consolidations;
DROP FUNCTION IF EXISTS memory_consolidations_append_only();
DROP TRIGGER IF EXISTS memory_consolidations_scope ON memory_consolidations;
DROP FUNCTION IF EXISTS memory_consolidations_scope();
DROP TABLE IF EXISTS memory_consolidations;
