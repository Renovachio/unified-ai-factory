-- 0010_db_roles: least-privilege database roles for privilege separation (ACT-05 SEC-05).
-- NOLOGIN group roles; the operator creates one LOGIN role per deployed component and grants it exactly one of these.
--   factory_runner  untrusted-adjacent workers: lease/heartbeat tasks, append events, record run output. NO approvals, merge, users, sessions, policy or credential references.
--   factory_merge   the merge authority: write merge intents, read evidence/approvals/policy. NO user/session/credential tables, cannot create approvals.
--   factory_control API + orchestrator: everything the control plane needs EXCEPT writing merge intents (only the merge authority merges).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_runner') THEN CREATE ROLE factory_runner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_merge') THEN CREATE ROLE factory_merge NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_control') THEN CREATE ROLE factory_control NOLOGIN; END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM factory_runner, factory_merge, factory_control;
GRANT USAGE ON SCHEMA public TO factory_runner, factory_merge, factory_control;

-- runner
GRANT SELECT ON jobs, requests, repositories, candidates, pull_requests, artifacts, gate_results, review_results, tasks, workers, agent_runs, events, allowed_transitions TO factory_runner;
GRANT UPDATE (event_seq) ON jobs TO factory_runner;                       -- event sequence allocation only; never state
GRANT INSERT, UPDATE ON tasks, workers, agent_runs TO factory_runner;
GRANT INSERT ON events, outbox, artifacts, gate_results, review_results, audit_entries TO factory_runner;
GRANT SELECT, UPDATE ON outbox TO factory_runner;

-- merge authority
GRANT SELECT ON jobs, requests, repositories, candidates, pull_requests, artifacts, gate_results, review_results, policy_decisions, approvals, events, tasks, allowed_transitions, job_transitions, auto_merge_global, auto_merge_repo_controls, integrations TO factory_merge;
GRANT INSERT, UPDATE ON merge_intents TO factory_merge;
GRANT SELECT ON merge_intents TO factory_merge;
GRANT UPDATE ON jobs TO factory_merge;                                    -- state transitions are enforced by triggers/guards
GRANT INSERT ON job_transitions, events, outbox, audit_entries TO factory_merge;
GRANT SELECT, UPDATE ON outbox TO factory_merge;

-- control plane
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO factory_control;
REVOKE INSERT, UPDATE ON merge_intents FROM factory_control;
REVOKE INSERT, UPDATE ON approvals FROM factory_merge;
GRANT SELECT ON merge_intents TO factory_control;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO factory_runner, factory_merge, factory_control;
