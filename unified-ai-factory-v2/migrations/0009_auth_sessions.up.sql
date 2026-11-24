-- 0009_auth_sessions: server-side dashboard sessions and OIDC login transactions (ACT-04).
-- Session ids and login state are stored only as SHA-256 hashes: a database read cannot be replayed as a cookie.
CREATE TABLE auth_login_transactions (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_to text NOT NULL,
  browser_binding_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE auth_sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  csrf text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  replaced_by text,
  CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;
