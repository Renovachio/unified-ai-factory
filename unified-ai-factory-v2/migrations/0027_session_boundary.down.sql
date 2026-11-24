-- Rollback of 0027: restore the control role's session writes (the 0010 grant) and remove the login role and function.
GRANT INSERT, UPDATE ON auth_sessions TO factory_control;
DROP FUNCTION IF EXISTS create_auth_session(text, uuid, text, timestamptz, timestamptz, text);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM factory_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM factory_login;
REVOKE USAGE ON SCHEMA public FROM factory_login;
DROP ROLE IF EXISTS factory_login;
