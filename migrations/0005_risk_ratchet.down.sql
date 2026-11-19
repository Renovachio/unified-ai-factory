DROP TRIGGER IF EXISTS jobs_risk_ratchet ON jobs;
DROP FUNCTION IF EXISTS enforce_risk_ratchet();
ALTER TABLE jobs DROP COLUMN IF EXISTS risk_classified;
