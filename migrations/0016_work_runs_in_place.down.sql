DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_runs WHERE mode = 'in_place') THEN
    RAISE EXCEPTION 'cannot roll back 0016: in-place work runs exist';
  END IF;
END $$;
ALTER TABLE work_runs DROP CONSTRAINT work_runs_in_place_snapshot;
ALTER TABLE work_runs DROP COLUMN snapshot_dir;
ALTER TABLE work_runs DROP COLUMN mode;
