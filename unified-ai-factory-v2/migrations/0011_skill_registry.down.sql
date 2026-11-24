DROP FUNCTION IF EXISTS registry_policy_disable(uuid, double precision, integer, text);
DROP TABLE IF EXISTS rollback_policies, job_skill_pins, registry_log, registry_active, approval_decisions, approval_requests, skill_validations, skill_versions CASCADE;
DROP FUNCTION IF EXISTS approval_decisions_guard();
DROP FUNCTION IF EXISTS skill_versions_guard();
-- factory_supervisor is cluster-wide and intentionally not dropped.
