-- Adaptive Memory v2.5, approval records (follow-up to 0028): an approvals row must name an enabled approver or admin of the
-- organization that owns the job. Before this, factory_approval could insert a row for a viewer, a disabled user or another
-- organization's approver (approval_decisions already had this check, migration 0011). factory_merge reads approvals as a merge input.
-- Superusers (the operator's migration and admin sessions) are exempt, as in migration 0029.
CREATE FUNCTION approvals_actor_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM users u JOIN jobs j ON j.id = NEW.job_id JOIN repositories r ON r.id = j.repository_id
      WHERE u.id = NEW.actor_id AND u.organization_id = r.organization_id AND u.role IN ('approver','admin') AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'approval actor must be an enabled approver or admin of the job organization';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_actor_guard BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION approvals_actor_guard();
