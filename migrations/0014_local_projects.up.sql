-- Local projects (Dispatch v2.3): a project may be a folder on this machine instead of a GitHub repository. Additive.
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_provider_check;
ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check CHECK (provider IN ('github', 'local'));
ALTER TABLE repositories ADD COLUMN local_path text;
-- A local project must have a path and a GitHub one must not; the path is the resolved real path (also stored as external_id's source).
ALTER TABLE repositories ADD CONSTRAINT repositories_local_path_matches_provider CHECK ((provider = 'local') = (local_path IS NOT NULL));
