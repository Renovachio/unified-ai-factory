-- Rollback of 0025: restore the 0024 guard and drop the hardening triggers. Refuses if a restore or any consolidation has
-- happened, because those are audit history that the 0024 rules cannot express.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memory_transitions t WHERE t.from_status = 'superseded' AND t.to_status = 'approved') THEN
    RAISE EXCEPTION 'cannot roll back 0025: a consolidation restore has happened and is audit history';
  END IF;
  IF EXISTS (SELECT 1 FROM memory_records WHERE is_consolidation) THEN
    RAISE EXCEPTION 'cannot roll back 0025: consolidated memories exist and are audit history';
  END IF;
END $$;
DROP TRIGGER IF EXISTS memory_records_transition_recorded ON memory_records;
DROP FUNCTION IF EXISTS memory_transition_recorded();
DROP TRIGGER IF EXISTS memory_records_birth ON memory_records;
DROP FUNCTION IF EXISTS memory_records_birth();
CREATE OR REPLACE FUNCTION memory_consolidations_scope() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION memory_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory_records rows are never hard-deleted; erase through a tombstone (status deleted)';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest OR NEW.record_version IS DISTINCT FROM OLD.record_version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.sensitivity IS DISTINCT FROM OLD.sensitivity THEN
    RAISE EXCEPTION 'memory record % is immutable provenance; create a new version instead', OLD.id;
  END IF;
  IF NEW.claim IS DISTINCT FROM OLD.claim OR NEW.normalized_claim_hash IS DISTINCT FROM OLD.normalized_claim_hash THEN
    IF NOT (NEW.status = 'deleted' AND OLD.status <> 'deleted') THEN
      RAISE EXCEPTION 'memory record % claim is immutable (only erasure may change it)', OLD.id;
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'superseded' AND NEW.status = 'approved' THEN
      IF NOT memory_restore_allowed(OLD) THEN
        RAISE EXCEPTION 'illegal memory transition % -> %', OLD.status, NEW.status;
      END IF;
      IF NEW.superseded_by IS NOT NULL OR NEW.valid_to IS NOT NULL THEN
        RAISE EXCEPTION 'restoring memory record % must clear its successor and validity window', OLD.id;
      END IF;
    ELSIF NOT memory_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'illegal memory transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'memory record % approver is immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE memory_records DROP COLUMN is_consolidation;
