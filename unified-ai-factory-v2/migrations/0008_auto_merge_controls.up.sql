-- 0008_auto_merge_controls: rollout controls for opt-in LOW-risk auto-merge (kill switch, per-repository opt-in, circuit breaker).
CREATE TABLE auto_merge_global (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  kill_switch boolean NOT NULL DEFAULT true,
  reason text,
  set_by text,
  set_at timestamptz NOT NULL DEFAULT now()
);
-- Inert by default: the kill switch starts ENGAGED; an operator must explicitly disarm it.
INSERT INTO auto_merge_global (id, kill_switch, reason, set_by) VALUES (1, true, 'default: auto-merge is off until an operator disarms the kill switch', 'system');
CREATE TABLE auto_merge_repo_controls (
  repository_id uuid PRIMARY KEY REFERENCES repositories(id),
  enabled boolean NOT NULL DEFAULT false,
  enabled_by text,
  enabled_on timestamptz,
  signoff jsonb,
  signoff_digest text,
  allowed_risks text[] NOT NULL DEFAULT ARRAY['LOW'] CHECK (allowed_risks <@ ARRAY['LOW','MEDIUM']::text[]),
  allowed_path_globs text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_per_day integer NOT NULL DEFAULT 3 CHECK (max_per_day BETWEEN 1 AND 50),
  cooldown_minutes integer NOT NULL DEFAULT 30 CHECK (cooldown_minutes BETWEEN 0 AND 1440),
  tripped_at timestamptz,
  trip_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (signoff_digest IS NOT NULL AND enabled_by IS NOT NULL))
);
ALTER TABLE merge_intents ADD COLUMN auto boolean NOT NULL DEFAULT false;
