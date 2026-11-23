-- Adaptive Memory v2.5, MEM-05: consolidation lineage. A consolidated memory is proposed from several approved originals.
-- The link rows are append-only and record exactly which originals a consolidated memory was built from. Originals are
-- superseded only when a human approves the consolidated memory (see lifecycle.approveMemory). Same organization and project
-- are enforced here, in the database, not only in application code.
CREATE TABLE memory_consolidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  consolidated_id uuid NOT NULL REFERENCES memory_records(id),
  original_id uuid NOT NULL REFERENCES memory_records(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_link_unique UNIQUE (consolidated_id, original_id),
  CONSTRAINT consolidation_not_self CHECK (consolidated_id <> original_id)
);
CREATE INDEX memory_consolidations_original_idx ON memory_consolidations (original_id);

CREATE FUNCTION memory_consolidations_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c memory_records%ROWTYPE; o memory_records%ROWTYPE;
BEGIN
  SELECT * INTO c FROM memory_records WHERE id = NEW.consolidated_id;
  SELECT * INTO o FROM memory_records WHERE id = NEW.original_id;
  IF c.organization_id <> NEW.organization_id OR o.organization_id <> NEW.organization_id
     OR c.project_id <> NEW.project_id OR o.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'consolidation links must stay within one organization and project';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_consolidations_scope BEFORE INSERT ON memory_consolidations
  FOR EACH ROW EXECUTE FUNCTION memory_consolidations_scope();

CREATE FUNCTION memory_consolidations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory_consolidations is append-only';
END $$;
CREATE TRIGGER memory_consolidations_append_only BEFORE UPDATE OR DELETE ON memory_consolidations
  FOR EACH ROW EXECUTE FUNCTION memory_consolidations_append_only();

GRANT SELECT, INSERT ON memory_consolidations TO factory_control;
