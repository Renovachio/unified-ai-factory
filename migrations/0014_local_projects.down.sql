-- Rollback refuses to silently destroy local projects (their jobs reference them).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM repositories WHERE provider = 'local') THEN
    RAISE EXCEPTION 'cannot roll back 0014: local projects exist; remove them (and their jobs) deliberately first';
  END IF;
END $$;
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_local_path_matches_provider;
ALTER TABLE repositories DROP COLUMN local_path;
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_provider_check;
ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check CHECK (provider IN ('github'));
