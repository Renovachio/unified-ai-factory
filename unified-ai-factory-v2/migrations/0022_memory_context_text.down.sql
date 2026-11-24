-- Rollback of 0022: refuse while packs exist, since their stored text is the evidence a run depends on.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM context_packs) THEN
    RAISE EXCEPTION 'cannot roll back 0022: context packs exist and their stored text is evidence';
  END IF;
END $$;
ALTER TABLE context_packs DROP COLUMN rendered_uri, DROP COLUMN rendered_digest;
