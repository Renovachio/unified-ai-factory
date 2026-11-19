REVOKE ALL ON ALL TABLES IN SCHEMA public FROM factory_runner, factory_merge, factory_control;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM factory_runner, factory_merge, factory_control;
REVOKE USAGE ON SCHEMA public FROM factory_runner, factory_merge, factory_control;
-- Roles are cluster-wide and may be shared by other databases, so they are intentionally not dropped.
