-- Rollback of 0018. Refuses to destroy ingestion history while any run exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memory_ingestion_runs) THEN
    RAISE EXCEPTION 'cannot roll back 0018: ingestion runs exist; export or erase them deliberately first';
  END IF;
END $$;
DROP TRIGGER IF EXISTS memory_ingestion_links_append_only ON memory_ingestion_links;
DROP TRIGGER IF EXISTS memory_ingestion_runs_append_only ON memory_ingestion_runs;
DROP FUNCTION IF EXISTS memory_ingestion_append_only();
DROP TABLE IF EXISTS memory_ingestion_links;
DROP TABLE IF EXISTS memory_ingestion_runs;
