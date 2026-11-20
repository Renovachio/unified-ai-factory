-- Rollback of 0028: restore the control role's approval writes (the 0010 grant) and remove the approval role.
GRANT INSERT, UPDATE ON approvals, approval_decisions TO factory_control;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM factory_approval;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM factory_approval;
REVOKE USAGE ON SCHEMA public FROM factory_approval;
DROP ROLE IF EXISTS factory_approval;
