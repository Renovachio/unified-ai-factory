-- Rollback of 0030: remove the approval actor guard.
DROP TRIGGER IF EXISTS approvals_actor_guard ON approvals;
DROP FUNCTION IF EXISTS approvals_actor_guard();
