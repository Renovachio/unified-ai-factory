-- Rollback of 0029: remove the approval guard and the approval role's update on product artifacts.
DROP TRIGGER IF EXISTS product_artifacts_approval_role ON product_artifacts;
DROP FUNCTION IF EXISTS product_artifacts_approval_role();
REVOKE UPDATE ON product_artifacts FROM factory_approval;
