-- 0001_core down: drops everything created by up (data loss: use only on disposable/rolled-back environments).
DROP TABLE IF EXISTS audit_entries, webhook_deliveries, outbox, events, merge_intents, approvals, policy_decisions,
  review_results, gate_results, artifacts, agent_runs, tasks, workers, job_transitions, allowed_transitions, jobs,
  requests, integrations, repositories, users, organizations CASCADE;
DROP SEQUENCE IF EXISTS fencing_token_seq;
DROP FUNCTION IF EXISTS enforce_job_transition();
DROP FUNCTION IF EXISTS forbid_mutation();
