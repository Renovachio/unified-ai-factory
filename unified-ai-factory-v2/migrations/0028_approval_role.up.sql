-- Adaptive Memory v2.5, approval separation (operator decision after the 0027 review):
-- approval records (approvals, approval_decisions) are written only by the approval handler, through factory_approval.
-- factory_control (general API and orchestrator) loses every write to them; it keeps SELECT.
-- factory_approval runs ONLY the two approval entry points: recordDecision (job approvals, orchestrator/src/decisions.ts)
-- and decideApproval (skill approvals, skills/src/registry.ts). Its writes are the ones those paths make; its reads are broad
-- because the evidence binding and the approval guards read many tables. It has NO access to session, login or credential tables.
-- Limit (stated): the approver identity is still the one the API resolved from the authenticated request. Guards check that the
-- approver is an enabled approver of the organization (approval_decisions: migration 0011; approvals: migration 0030; product
-- artifacts: migration 0029), not which person made the request.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_approval') THEN CREATE ROLE factory_approval NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO factory_approval;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO factory_approval;
REVOKE SELECT ON auth_sessions, auth_login_transactions, integrations FROM factory_approval;
GRANT INSERT ON approvals, approval_decisions, job_transitions, events, outbox, audit_entries, idempotency_keys TO factory_approval;
GRANT UPDATE ON jobs, skill_versions, idempotency_keys TO factory_approval;
GRANT DELETE ON idempotency_keys TO factory_approval; -- a failed claim is removed (decisions.ts)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO factory_approval;

REVOKE INSERT, UPDATE, DELETE ON approvals, approval_decisions FROM factory_control;
-- Observed: revoking table-level UPDATE also removed the 0011 column grant (probe, before this line). Restore exactly that column:
-- skill activation marks consumed_at.
GRANT UPDATE (consumed_at) ON approval_decisions TO factory_control;
