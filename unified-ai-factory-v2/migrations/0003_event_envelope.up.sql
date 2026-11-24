-- 0003_event_envelope: carry attempt and fencing token on events (additive; matches CONTRACTS/event.schema.json).
ALTER TABLE events ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1);
ALTER TABLE events ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0);
