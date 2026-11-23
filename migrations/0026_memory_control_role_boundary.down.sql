-- Rollback of 0026: restore the control role's user writes and the 0025 transition check.
GRANT INSERT, UPDATE ON users TO factory_control;
CREATE OR REPLACE FUNCTION memory_transition_recorded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM memory_transitions t WHERE t.memory_id = NEW.id AND t.to_status = NEW.status
        AND t.record_version = NEW.record_version AND t.created_at = now()) THEN
      RAISE EXCEPTION 'status change of memory % to % has no transition record in this transaction', NEW.id, NEW.status;
    END IF;
  END IF;
  RETURN NULL;
END $$;
