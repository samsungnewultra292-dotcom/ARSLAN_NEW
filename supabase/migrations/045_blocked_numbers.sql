-- ============================================================
-- 045_blocked_numbers.sql
--
-- CRM-level blocklist keyed on the normalized phone number
-- (digits only — see src/lib/whatsapp/phone-utils.normalizePhone).
--
-- What it does:
--   1. INBOUND — the webhook drops any message whose sender's phone
--      is blocked, before a contact/conversation is created, so the
--      number is filtered out of the inbox entirely. BSUID-only
--      senders (username-adopted, no disclosed number) can't match a
--      phone-keyed blocklist — accepted edge case: the check is keyed
--      on whatever phone exists.
--   2. OUTBOUND — every send path (inbox, quick replies, templates,
--      automations, Flows, broadcasts, the public API) consults this
--      table and refuses to message a blocked number.
--
-- Tenancy + role model mirrors quick_replies (migration 035) and the
-- other account-scoped tables: any member can read the list; agents+
-- can block / unblock. The unique index prevents duplicate normalized
-- numbers for the same account (idempotent block).
-- ============================================================

CREATE TABLE IF NOT EXISTS blocked_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenancy. Every member of the account shares its blocklist.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Who blocked it — audit only, never used for tenancy isolation.
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Digits-only key (normalizePhone). Unique per account so a second
  -- block of the same number is a no-op rather than a duplicate row.
  phone_normalized TEXT NOT NULL,
  -- Human-readable form as the agent typed it (e.g. +1 555 123 4567)
  -- so the list renders what was actually blocked.
  display_phone TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_numbers_account_phone
  ON blocked_numbers(account_id, phone_normalized);

CREATE INDEX IF NOT EXISTS idx_blocked_numbers_account
  ON blocked_numbers(account_id);

ALTER TABLE blocked_numbers ENABLE ROW LEVEL SECURITY;

-- Account-scoped policies mirroring quick_replies (see 017 + 035):
-- any member can read; agent+ can block / unblock.
DROP POLICY IF EXISTS blocked_numbers_select ON blocked_numbers;
DROP POLICY IF EXISTS blocked_numbers_insert ON blocked_numbers;
DROP POLICY IF EXISTS blocked_numbers_delete ON blocked_numbers;
CREATE POLICY blocked_numbers_select ON blocked_numbers FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY blocked_numbers_insert ON blocked_numbers FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY blocked_numbers_delete ON blocked_numbers FOR DELETE
  USING (is_account_member(account_id, 'agent'));