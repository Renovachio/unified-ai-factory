-- Adaptive Memory v2.5, MEM-02: evidence-based ingestion. Additive: one run per (project, source, digest, extractor) and
-- span links from each run to the memories it proposed. Memories themselves are created through memory_records (MEM-01).

CREATE TABLE memory_ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  source_kind text NOT NULL CHECK (source_kind IN ('artifact', 'event')),
  source_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  extractor_id text NOT NULL CHECK (extractor_id IN ('deterministic-v1')),
  -- Consent as stated by the actor: purpose, the user who granted it, and recording consent for transcripts.
  consent jsonb NOT NULL,
  candidates_total integer NOT NULL CHECK (candidates_total >= 0),
  proposed integer NOT NULL CHECK (proposed >= 0),
  dropped_secret integer NOT NULL CHECK (dropped_secret >= 0),
  dropped_injection integer NOT NULL CHECK (dropped_injection >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_ingestion_counts CHECK (proposed + dropped_secret + dropped_injection = candidates_total)
);
-- Idempotency: the same source content is ingested once per extractor version and project.
CREATE UNIQUE INDEX memory_ingestion_runs_once_uq ON memory_ingestion_runs (project_id, source_kind, source_id, source_digest, extractor_id);

CREATE TABLE memory_ingestion_links (
  run_id uuid NOT NULL REFERENCES memory_ingestion_runs(id),
  memory_id uuid NOT NULL REFERENCES memory_records(id),
  span_start integer NOT NULL CHECK (span_start >= 0),
  span_end integer NOT NULL CHECK (span_end > span_start),
  marker text NOT NULL CHECK (marker IN ('decision', 'requirement', 'constraint')),
  PRIMARY KEY (run_id, memory_id)
);

CREATE FUNCTION memory_ingestion_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER memory_ingestion_runs_append_only BEFORE UPDATE OR DELETE ON memory_ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION memory_ingestion_append_only();
CREATE TRIGGER memory_ingestion_links_append_only BEFORE UPDATE OR DELETE ON memory_ingestion_links
  FOR EACH ROW EXECUTE FUNCTION memory_ingestion_append_only();

-- Same least-privilege model as 0017: control plane only, no update or delete.
GRANT SELECT, INSERT ON memory_ingestion_runs, memory_ingestion_links TO factory_control;
