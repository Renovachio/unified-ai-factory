-- Rollback of 0021. Pack evidence is audit history: refuse while any pack exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM context_packs) THEN
    RAISE EXCEPTION 'cannot roll back 0021: context packs exist; export them deliberately first';
  END IF;
END $$;
DROP TRIGGER IF EXISTS context_packs_append_only ON context_packs;
DROP FUNCTION IF EXISTS context_packs_append_only();
DROP TABLE IF EXISTS context_packs;
