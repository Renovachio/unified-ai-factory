-- 0007_approval_binding: persist the FULL 8-field evidence binding with each (append-only) approval decision.
ALTER TABLE approvals ADD COLUMN binding jsonb NOT NULL DEFAULT '{}';
ALTER TABLE merge_intents ADD COLUMN reason text;
ALTER TABLE merge_intents ADD COLUMN merge_method text NOT NULL DEFAULT 'squash' CHECK (merge_method IN ('squash','merge','rebase'));
