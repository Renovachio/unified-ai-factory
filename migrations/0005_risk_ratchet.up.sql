-- 0005_risk_ratchet: once a job's risk has been classified it can only go UP (never be lowered by later content or model output).
ALTER TABLE jobs ADD COLUMN risk_classified boolean NOT NULL DEFAULT false;
CREATE FUNCTION enforce_risk_ratchet() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF OLD.risk_classified THEN
    old_rank := array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'], OLD.risk);
    new_rank := array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'], NEW.risk);
    IF new_rank < old_rank THEN
      RAISE EXCEPTION 'job risk can only increase once classified (% -> %)', OLD.risk, NEW.risk USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW.risk_classified THEN
      RAISE EXCEPTION 'risk_classified cannot be reset' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_risk_ratchet BEFORE UPDATE OF risk, risk_classified ON jobs FOR EACH ROW EXECUTE FUNCTION enforce_risk_ratchet();
