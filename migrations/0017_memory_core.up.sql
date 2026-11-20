-- Adaptive Memory v2.5, MEM-01: canonical memory records, source links, transition history and tombstones.
-- Additive only: no existing table is altered. Reuses organizations (tenant), repositories (project), users, artifacts,
-- events and audit_entries. Project scope is repositories.id; a memory never spans projects.

-- Canonical memory records. A claim is immutable once written; a change is a NEW record_version that supersedes the old one.
-- The only mutable columns are status, superseded_by, valid_to, approved_by and updated_at (see memory_records_guard).
CREATE TABLE memory_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  kind text NOT NULL CHECK (kind IN ('decision', 'requirement', 'fact', 'constraint', 'note')),
  -- Claim text is DATA. It is bounded, never executed and never interpreted as an instruction.
  claim text NOT NULL,
  normalized_claim_hash text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded', 'revoked', 'deleted')),
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version >= 1),
  supersedes_id uuid REFERENCES memory_records(id),
  superseded_by uuid REFERENCES memory_records(id),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_claim_bounded CHECK (status = 'deleted' OR char_length(claim) BETWEEN 1 AND 4000),
  -- Erasure removes the content and its content-derived hash; only the tombstone and provenance receipts remain.
  CONSTRAINT memory_erased_content CHECK (status <> 'deleted' OR (claim = '' AND normalized_claim_hash = 'erased')),
  -- An approved memory always has a human approver, and the author can never approve their own memory.
  CONSTRAINT memory_approved_has_approver CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  CONSTRAINT memory_no_self_approval CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT memory_superseded_has_successor CHECK (status <> 'superseded' OR superseded_by IS NOT NULL),
  CONSTRAINT memory_revision_chain CHECK (supersedes_id IS NULL OR record_version > 1),
  CONSTRAINT memory_no_self_reference CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

-- Idempotent proposal: the same normalized claim from the same source digest is one record per version.
-- Deleted rows are excluded so an erased claim does not block a legitimate later proposal.
CREATE UNIQUE INDEX memory_records_idempotent_uq
  ON memory_records (organization_id, project_id, normalized_claim_hash, source_digest, record_version)
  WHERE status <> 'deleted';
CREATE INDEX memory_records_scope_idx ON memory_records (organization_id, project_id, status, valid_from);

-- Provenance: every memory needs at least one source; each source is one event or artifact of the SAME project.
CREATE TABLE memory_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memory_records(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  artifact_id uuid REFERENCES artifacts(id),
  event_id uuid REFERENCES events(id),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_span jsonb,
  extraction_method text NOT NULL CHECK (extraction_method IN ('user_statement', 'deterministic', 'candidate_llm')),
  acl_digest text NOT NULL CHECK (acl_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Once set, a source is revoked for good. Any revoked source makes its memories unusable (fail closed).
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_source_single_origin CHECK (num_nonnulls(artifact_id, event_id) = 1)
);
CREATE INDEX memory_sources_memory_idx ON memory_sources (memory_id);
CREATE INDEX memory_sources_scope_idx ON memory_sources (organization_id, project_id, revoked_at);

-- Append-only lifecycle history. Every status change writes one row in the same transaction as the audit entry.
CREATE TABLE memory_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memory_records(id),
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('proposed', 'approved', 'rejected', 'superseded', 'revoked', 'deleted')),
  record_version integer NOT NULL,
  actor_id uuid REFERENCES users(id),
  actor text NOT NULL,
  reason text,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_transitions_memory_idx ON memory_transitions (memory_id, created_at);

-- Minimal, content-free receipt of a deletion request. It records who, when and why, never the erased claim.
CREATE TABLE memory_tombstones (
  memory_id uuid PRIMARY KEY REFERENCES memory_records(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  -- Per-projection purge progress (indexes, caches, summaries arrive with MEM-03..05).
  purge_status jsonb NOT NULL DEFAULT '{"canonical":"erased"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Project-level revocation of one evidence item. Recorded even when no memory cites the item yet, so a revoked artifact can
-- never back a NEW memory. Append-only.
CREATE TABLE memory_source_revocations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES repositories(id),
  source_kind text NOT NULL CHECK (source_kind IN ('artifact', 'event')),
  source_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  revoked_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_kind, source_id)
);

CREATE FUNCTION memory_source_revocations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory_source_revocations is append-only';
END $$;
CREATE TRIGGER memory_source_revocations_append_only BEFORE UPDATE OR DELETE ON memory_source_revocations
  FOR EACH ROW EXECUTE FUNCTION memory_source_revocations_append_only();

-- Legal lifecycle, enforced by the database even if application code is bypassed. Mirrors packages/memory/src/domain.ts.
CREATE FUNCTION memory_transition_allowed(from_status text, to_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE from_status
    WHEN 'proposed' THEN to_status IN ('approved', 'rejected', 'revoked', 'deleted')
    WHEN 'approved' THEN to_status IN ('superseded', 'revoked', 'deleted')
    WHEN 'revoked' THEN to_status = 'deleted'
    WHEN 'rejected' THEN to_status = 'deleted'
    WHEN 'superseded' THEN to_status = 'deleted'
    ELSE false
  END
$$;

CREATE FUNCTION memory_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory_records rows are never hard-deleted; erase through a tombstone (status deleted)';
  END IF;
  -- Identity, scope, provenance and version are write-once.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest OR NEW.record_version IS DISTINCT FROM OLD.record_version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.sensitivity IS DISTINCT FROM OLD.sensitivity THEN
    RAISE EXCEPTION 'memory record % is immutable provenance; create a new version instead', OLD.id;
  END IF;
  -- The claim changes only by erasure. Approved or in-review text is never rewritten.
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
  -- An approved approver is write-once too.
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'memory record % approver is immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_records_guard BEFORE UPDATE OR DELETE ON memory_records
  FOR EACH ROW EXECUTE FUNCTION memory_records_guard();

CREATE FUNCTION memory_sources_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory_sources rows are provenance and cannot be deleted';
  END IF;
  IF NEW.memory_id IS DISTINCT FROM OLD.memory_id OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
     OR NEW.acl_digest IS DISTINCT FROM OLD.acl_digest OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.extraction_method IS DISTINCT FROM OLD.extraction_method THEN
    RAISE EXCEPTION 'memory source % is immutable provenance', OLD.id;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'memory source % revocation cannot be undone', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_sources_guard BEFORE UPDATE OR DELETE ON memory_sources
  FOR EACH ROW EXECUTE FUNCTION memory_sources_guard();

CREATE FUNCTION memory_transitions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory_transitions is append-only';
END $$;
CREATE TRIGGER memory_transitions_append_only BEFORE UPDATE OR DELETE ON memory_transitions
  FOR EACH ROW EXECUTE FUNCTION memory_transitions_append_only();

CREATE FUNCTION memory_tombstones_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory_tombstones is append-only';
END $$;
CREATE TRIGGER memory_tombstones_append_only BEFORE UPDATE OR DELETE ON memory_tombstones
  FOR EACH ROW EXECUTE FUNCTION memory_tombstones_append_only();
