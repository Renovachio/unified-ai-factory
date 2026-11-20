-- Adaptive Memory v2.5, Option A (operator decision after the second independent review of 0025):
--  1. The control role (factory_control, used by the API and orchestrator) cannot create users or change their role or
--     disabled status. Those writes are done by the database owner (operator). Only SELECT remains on users.
--  2. The commit-time transition check is stricter: the transition row must match the status change in from_status and
--     to_status and record_version, and an approval's transition actor must be the approver recorded on the memory.
-- Limit (stated, not closed here): the control role can still insert transition rows and can name any existing approver.
-- Closing that needs a per-user database identity or a session-bound actor, which is a separate decision.

REVOKE INSERT, UPDATE ON users FROM factory_control;

CREATE OR REPLACE FUNCTION memory_transition_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM memory_transitions t WHERE t.memory_id = NEW.id AND t.from_status IS NULL
        AND t.to_status = NEW.status AND t.record_version = NEW.record_version AND t.created_at = now()) THEN
      RAISE EXCEPTION 'creation of memory % has no matching transition record in this transaction', NEW.id;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM memory_transitions t WHERE t.memory_id = NEW.id AND t.from_status = OLD.status
        AND t.to_status = NEW.status AND t.record_version = NEW.record_version AND t.created_at = now()) THEN
      RAISE EXCEPTION 'status change of memory % from % to % has no matching transition record in this transaction', NEW.id, OLD.status, NEW.status;
    END IF;
    IF OLD.status = 'proposed' AND NEW.status = 'approved' THEN
      IF NOT EXISTS (SELECT 1 FROM memory_transitions t WHERE t.memory_id = NEW.id AND t.from_status = 'proposed'
          AND t.to_status = 'approved' AND t.actor_id = NEW.approved_by AND t.record_version = NEW.record_version AND t.created_at = now()) THEN
        RAISE EXCEPTION 'approval of memory % must be recorded by the approver on the memory', NEW.id;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;
