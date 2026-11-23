-- Rollback of 0028: restore the grants exactly as they were before 0028 (0010 for approvals; 0011 for approval_decisions).
GRANT INSERT, UPDATE ON approvals TO factory_control;
GRANT INSERT ON approval_decisions TO factory_control;
GRANT UPDATE (consumed_at) ON approval_decisions TO factory_control;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM factory_approval;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM factory_approval;
REVOKE USAGE ON SCHEMA public FROM factory_approval;
DROP ROLE IF EXISTS factory_approval;
