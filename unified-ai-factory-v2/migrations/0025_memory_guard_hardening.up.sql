-- Adaptive Memory v2.5, MEM-05 review fixes (independent review of 0017-0024). The database now enforces what the code and
-- the migration headers claim, not only the application path:
--  1. superseded_by changes only by supersession (approved -> superseded, to a successor in the same organization and project)
--     and by restore (see memory_restore_allowed). Raw SQL can no longer re-point or clear a live supersession.
--  2. approved_by is set only on the proposed -> approved transition, by an enabled approver (role approver or admin) of the
--     same organization, and never changes afterwards.
--  3. valid_to changes only with supersession and restore.
--  4. Every row is born 'proposed' with no approver, successor or validity window.
--  5. Every status change (and every insert) needs a memory_transitions row written in the same transaction. Checked at commit
--     (deferred constraint trigger), so a raw status change cannot skip the audit trail.
--  6. Consolidation links connect a PROPOSED CONSOLIDATED memory (is_consolidation, set at creation, immutable) to APPROVED
--     originals of the same kind. A plain memory can never receive links.

ALTER TABLE memory_records ADD COLUMN is_consolidation boolean NOT NULL DEFAULT false;
-- Backfill: every memory that already has consolidation links is a consolidated memory. Runs before the guard enforces the flag.
UPDATE memory_records SET is_consolidation = true WHERE id IN (SELECT consolidated_id FROM memory_consolidations);

CREATE OR REPLACE FUNCTION memory_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approver record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory_records rows are never hard-deleted; erase through a tombstone (status deleted)';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest OR NEW.record_version IS DISTINCT FROM OLD.record_version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.sensitivity IS DISTINCT FROM OLD.sensitivity OR NEW.is_consolidation IS DISTINCT FROM OLD.is_consolidation THEN
    RAISE EXCEPTION 'memory record % is immutable provenance; create a new version instead', OLD.id;
  END IF;
  IF NEW.claim IS DISTINCT FROM OLD.claim OR NEW.normalized_claim_hash IS DISTINCT FROM OLD.normalized_claim_hash THEN
    IF NOT (NEW.status = 'deleted' AND OLD.status <> 'deleted') THEN
      RAISE EXCEPTION 'memory record % claim is immutable (only erasure may change it)', OLD.id;
    END IF;
  END IF;

  -- Status: the generic matrix, plus the single restore exception from 0024.
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

  -- superseded_by: set only by supersession, cleared only by restore, never re-pointed.
  IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
    IF OLD.superseded_by IS NULL AND OLD.status = 'approved' AND NEW.status = 'superseded' AND NEW.superseded_by IS NOT NULL THEN
      IF NEW.superseded_by = NEW.id THEN
        RAISE EXCEPTION 'memory % cannot supersede itself', OLD.id;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM memory_records s WHERE s.id = NEW.superseded_by
          AND s.organization_id = NEW.organization_id AND s.project_id = NEW.project_id) THEN
        RAISE EXCEPTION 'successor of memory % must be in the same organization and project', OLD.id;
      END IF;
      -- A consolidated successor supersedes only through its links, and only once it is approved.
      IF EXISTS (SELECT 1 FROM memory_records s WHERE s.id = NEW.superseded_by AND s.is_consolidation) THEN
        IF NOT EXISTS (SELECT 1 FROM memory_records s WHERE s.id = NEW.superseded_by AND s.status = 'approved')
           OR NOT EXISTS (SELECT 1 FROM memory_consolidations c WHERE c.consolidated_id = NEW.superseded_by AND c.original_id = NEW.id) THEN
          RAISE EXCEPTION 'memory % can be superseded by a consolidated memory only through its approved consolidation', OLD.id;
        END IF;
      END IF;
    ELSIF OLD.status = 'superseded' AND NEW.status = 'approved' AND NEW.superseded_by IS NULL AND memory_restore_allowed(OLD) THEN
      NULL; -- restore clears the successor
    ELSE
      RAISE EXCEPTION 'superseded_by of memory % is immutable outside supersession and restore', OLD.id;
    END IF;
  END IF;

  -- valid_to: set only with supersession, cleared only with restore.
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    IF NOT ((OLD.valid_to IS NULL AND NEW.status = 'superseded') OR (OLD.status = 'superseded' AND NEW.status = 'approved' AND NEW.valid_to IS NULL)) THEN
      RAISE EXCEPTION 'validity window of memory % may change only with supersession or restore', OLD.id;
    END IF;
  END IF;

  -- approved_by: set once, on proposed -> approved, by an enabled approver of the same organization. Never changed afterwards.
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    IF OLD.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'memory record % approver is immutable', OLD.id;
    END IF;
    IF NOT (OLD.status = 'proposed' AND NEW.status = 'approved') THEN
      RAISE EXCEPTION 'memory record % may gain an approver only when it is approved from proposed', OLD.id;
    END IF;
    SELECT u.role, u.disabled_at, u.organization_id INTO approver FROM users u WHERE u.id = NEW.approved_by;
    IF approver IS NULL OR approver.disabled_at IS NOT NULL OR approver.organization_id <> NEW.organization_id
       OR approver.role NOT IN ('approver', 'admin') THEN
      RAISE EXCEPTION 'memory record % approver must be an enabled approver or admin of the same organization', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Every row is born proposed, with no approver, successor or validity window.
CREATE FUNCTION memory_records_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'a memory is created only as proposed, without approver, successor or validity window';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_records_birth BEFORE INSERT ON memory_records
  FOR EACH ROW EXECUTE FUNCTION memory_records_birth();

-- Every status change and every insert is recorded in memory_transitions in the same transaction. Checked at commit.
CREATE FUNCTION memory_transition_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM memory_transitions t WHERE t.memory_id = NEW.id AND t.to_status = NEW.status
        AND t.record_version = NEW.record_version AND t.created_at = now()) THEN
      RAISE EXCEPTION 'status change of memory % to % has no transition record in this transaction', NEW.id, NEW.status;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER memory_records_transition_recorded AFTER INSERT OR UPDATE OF status ON memory_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_transition_recorded();

-- Consolidation links: a proposed consolidated memory of kind K, linked to approved originals of kind K.
CREATE OR REPLACE FUNCTION memory_consolidations_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c memory_records%ROWTYPE; o memory_records%ROWTYPE;
BEGIN
  SELECT * INTO c FROM memory_records WHERE id = NEW.consolidated_id;
  SELECT * INTO o FROM memory_records WHERE id = NEW.original_id;
  IF c.organization_id <> NEW.organization_id OR o.organization_id <> NEW.organization_id
     OR c.project_id <> NEW.project_id OR o.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'consolidation links must stay within one organization and project';
  END IF;
  IF NOT c.is_consolidation THEN
    RAISE EXCEPTION 'links can be attached only to a consolidated memory';
  END IF;
  IF c.status <> 'proposed' THEN
    RAISE EXCEPTION 'originals can be linked only to a proposed consolidated memory';
  END IF;
  IF o.status <> 'approved' THEN
    RAISE EXCEPTION 'only approved memories can be consolidation originals';
  END IF;
  IF c.kind <> o.kind THEN
    RAISE EXCEPTION 'consolidation originals must share the consolidated memory kind';
  END IF;
  RETURN NEW;
END $$;
