-- Adaptive Memory v2.5, MEM-04 follow-up: packs keep their rendered text as a content-addressed artifact, so a run can be
-- reproduced and verified. The digest of that text is also bound into the manifest. Required columns: a database that
-- already holds packs cannot receive this migration silently (the ALTER fails on existing rows).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM context_packs) THEN
    RAISE EXCEPTION 'cannot apply 0022: context_packs already has rows without stored text; export and clear them deliberately first';
  END IF;
END $$;
ALTER TABLE context_packs
  ADD COLUMN rendered_digest text NOT NULL CHECK (rendered_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN rendered_uri text NOT NULL CHECK (char_length(rendered_uri) BETWEEN 1 AND 2000);
