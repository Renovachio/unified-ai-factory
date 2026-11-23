-- Rollback of 0019. The index is a rebuildable projection and may be dropped freely. The retrieval log is audit history:
-- refuse while any retrieval event exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memory_retrieval_events) THEN
    RAISE EXCEPTION 'cannot roll back 0019: retrieval events exist; export them deliberately first';
  END IF;
END $$;
DROP TRIGGER IF EXISTS memory_retrieval_events_append_only ON memory_retrieval_events;
DROP FUNCTION IF EXISTS memory_retrieval_events_append_only();
DROP TABLE IF EXISTS memory_retrieval_events;
DROP TRIGGER IF EXISTS memory_index_maintain ON memory_records;
DROP FUNCTION IF EXISTS memory_index_maintain();
DROP TABLE IF EXISTS memory_index;
