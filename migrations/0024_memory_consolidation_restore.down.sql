-- Rollback of 0024: restore the 0017 guard exactly (no superseded -> approved exception). Refuse if a restore happened, because
-- a restored original is now approved again and rolling back would leave the lineage ambiguous.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM memory_transitions t WHERE t.from_status = 'superseded' AND t.to_status = 'approved') THEN
    RAISE EXCEPTION 'cannot roll back 0024: a consolidation restore has happened and is audit history';
  END IF;
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
    IF NOT memory_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'illegal memory transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'memory record % approver is immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$;
DROP FUNCTION IF EXISTS memory_restore_allowed(memory_records);
