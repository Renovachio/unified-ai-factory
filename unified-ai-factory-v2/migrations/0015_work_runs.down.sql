-- Rollback refuses to destroy a decision record: applied/rejected runs are the audit trail of what a human approved.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_runs WHERE status IN ('applied', 'rejected')) THEN
    RAISE EXCEPTION 'cannot roll back 0015: decided work runs exist';
  END IF;
END $$;
DROP TABLE work_runs;
