-- Adaptive Memory v2.5, product artifact approval (follow-up to 0028): approving or superseding a product artifact, and setting
-- approved_by, is allowed only from the approval role (factory_approval) or a superuser. This applies to INSERT as well as UPDATE:
-- a row created already approved is an approval too. factory_control can still create drafts and move them to in_review.
-- The approver must be an enabled approver or admin of the artifact's organization (checked when approved_by is set or changes).
-- Column grants cannot express this because control and approval both write the same state column, so the guard is a trigger.
CREATE FUNCTION product_artifacts_approval_role() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE approving boolean; check_approver boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    approving := NEW.state IN ('approved','superseded') OR NEW.approved_by IS NOT NULL;
    check_approver := NEW.approved_by IS NOT NULL;
  ELSE
    approving := (NEW.state IN ('approved','superseded') AND NEW.state IS DISTINCT FROM OLD.state)
                 OR NEW.approved_by IS DISTINCT FROM OLD.approved_by;
    check_approver := NEW.approved_by IS DISTINCT FROM OLD.approved_by
                      OR (NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved');
  END IF;
  IF approving THEN
    IF NOT (pg_has_role(current_user, 'factory_approval', 'MEMBER')
            OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) THEN
      RAISE EXCEPTION 'artifact approval requires the approval role';
    END IF;
  END IF;
  IF check_approver AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.approved_by AND u.organization_id = NEW.organization_id
      AND u.role IN ('approver','admin') AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'artifact approver must be an enabled approver of the organization';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_artifacts_approval_role BEFORE INSERT OR UPDATE ON product_artifacts
  FOR EACH ROW EXECUTE FUNCTION product_artifacts_approval_role();
GRANT UPDATE ON product_artifacts TO factory_approval;
