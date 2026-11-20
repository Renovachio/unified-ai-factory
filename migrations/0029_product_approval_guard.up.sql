-- Adaptive Memory v2.5, product artifact approval (follow-up to 0028): approving or superseding a product artifact, and setting
-- approved_by, is allowed only from the approval role (factory_approval) or a superuser (the operator's migration and admin
-- session). factory_control can still move an artifact to in_review (draft submission) but cannot approve it.
-- Column grants cannot express this because control and approval both write the same state column, so the guard is a trigger.
-- Limit (stated): the approver identity is still the one the API resolved; the existing CHECK ensures approver <> author.
CREATE FUNCTION product_artifacts_approval_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((NEW.state IN ('approved','superseded') AND NEW.state IS DISTINCT FROM OLD.state)
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    IF NOT (pg_has_role(current_user, 'factory_approval', 'MEMBER')
            OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) THEN
      RAISE EXCEPTION 'artifact approval requires the approval role';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_artifacts_approval_role BEFORE UPDATE ON product_artifacts
  FOR EACH ROW EXECUTE FUNCTION product_artifacts_approval_role();
GRANT UPDATE ON product_artifacts TO factory_approval;
