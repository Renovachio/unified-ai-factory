-- In-place work runs (Dispatch v2.3): the agents edit the REAL folder after a snapshot. `mode` says which kind of run it is; `snapshot_dir` is where
-- Dispatch keeps the pre-run copy used for the diff and for undo. Additive.
ALTER TABLE work_runs ADD COLUMN mode text NOT NULL DEFAULT 'copy' CHECK (mode IN ('copy', 'in_place'));
ALTER TABLE work_runs ADD COLUMN snapshot_dir text;
ALTER TABLE work_runs ADD CONSTRAINT work_runs_in_place_snapshot CHECK (mode <> 'in_place' OR snapshot_dir IS NOT NULL);
