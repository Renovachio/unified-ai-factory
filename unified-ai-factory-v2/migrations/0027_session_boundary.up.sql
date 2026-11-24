-- Adaptive Memory v2.5, Option (a) (operator decision after the third review of 0026): login sessions are created only by the
-- login component. Sessions were the one way the control role could act as another user (it could insert an auth_sessions row
-- for any enabled user). After this migration:
--   * factory_login (NOLOGIN group, granted to the operator's login LOGIN role) runs login: it reads users, reads and revokes
--     sessions, consumes single-use login transactions and writes audit rows.
--   * create_auth_session() (SECURITY DEFINER, owned by the migrating role) is the ONLY way to create or rotate a session. It
--     refuses unless the user exists and is enabled.
--   * factory_control keeps SELECT on auth_sessions and loses every write to it.
-- Limit (stated): approvals and approval_decisions are still written by the control plane. Their approver identity is bound by
-- the API session check, not by the database. Session-bound approval functions are a separate, later change.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factory_login') THEN CREATE ROLE factory_login NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO factory_login;
GRANT SELECT ON users TO factory_login;
GRANT SELECT, UPDATE ON auth_sessions TO factory_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_login_transactions TO factory_login;
GRANT INSERT ON audit_entries TO factory_login;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO factory_login;

CREATE FUNCTION create_auth_session(p_id_hash text, p_user_id uuid, p_csrf text, p_now timestamptz,
    p_expires_at timestamptz, p_replacing text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'session refused: user is not an enabled account';
  END IF;
  INSERT INTO auth_sessions (id_hash, user_id, csrf, created_at, last_seen_at, rotated_at, expires_at)
    VALUES (p_id_hash, p_user_id, p_csrf, p_now, p_now, p_now, p_expires_at);
  IF p_replacing IS NOT NULL THEN
    UPDATE auth_sessions SET revoked_at = p_now, revoke_reason = 'rotated', replaced_by = p_id_hash
      WHERE id_hash = p_replacing AND revoked_at IS NULL;
  END IF;
END $$;
REVOKE ALL ON FUNCTION create_auth_session(text, uuid, text, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_auth_session(text, uuid, text, timestamptz, timestamptz, text) TO factory_login;

REVOKE INSERT, UPDATE, DELETE ON auth_sessions FROM factory_control;
