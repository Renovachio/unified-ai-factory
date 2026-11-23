-- Adaptive Memory v2.5, MEM-05 follow-up: restore originals after their consolidation ended. The generic lifecycle matrix is
-- NOT changed (superseded -> approved stays illegal in general, and the TypeScript/SQL parity test still holds). One narrow
-- exception exists in the guard: an ORIGINAL that is superseded by a CONSOLIDATED memory may return to approved only when that
-- consolidated memory is now revoked or erased, and then the successor link and validity window must be cleared.
CREATE FUNCTION memory_restore_allowed(orig memory_records) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT orig.superseded_by IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_consolidations c JOIN memory_records p ON p.id = c.consolidated_id
    WHERE c.original_id = orig.id AND c.consolidated_id = orig.superseded_by AND p.status IN ('revoked', 'deleted'))
$$;

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
