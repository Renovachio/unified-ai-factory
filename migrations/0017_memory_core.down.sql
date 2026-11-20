-- Rollback of 0017. Refuses to destroy memory: once any memory, tombstone or revocation exists, the rollback must be a
-- deliberate, documented data decision, not a side effect of reverting code.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memory_records) OR EXISTS (SELECT 1 FROM memory_tombstones) OR EXISTS (SELECT 1 FROM memory_source_revocations) THEN
    RAISE EXCEPTION 'cannot roll back 0017: memory records, tombstones or revocations exist; export or erase them deliberately first';
  END IF;
END $$;
DROP TRIGGER IF EXISTS memory_source_revocations_append_only ON memory_source_revocations;
DROP FUNCTION IF EXISTS memory_source_revocations_append_only();
DROP TRIGGER IF EXISTS memory_tombstones_append_only ON memory_tombstones;
DROP FUNCTION IF EXISTS memory_tombstones_append_only();
DROP TRIGGER IF EXISTS memory_transitions_append_only ON memory_transitions;
DROP FUNCTION IF EXISTS memory_transitions_append_only();
DROP TRIGGER IF EXISTS memory_sources_guard ON memory_sources;
DROP FUNCTION IF EXISTS memory_sources_guard();
DROP TRIGGER IF EXISTS memory_records_guard ON memory_records;
DROP FUNCTION IF EXISTS memory_records_guard();
DROP FUNCTION IF EXISTS memory_transition_allowed(text, text);
DROP TABLE IF EXISTS memory_source_revocations;
DROP TABLE IF EXISTS memory_tombstones;
DROP TABLE IF EXISTS memory_transitions;
DROP TABLE IF EXISTS memory_sources;
DROP TABLE IF EXISTS memory_records;
