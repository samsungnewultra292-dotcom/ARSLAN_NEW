-- ============================================================
-- 044_quick_reply_video.sql
--
-- Adds the 'video' kind to quick_replies: a reusable snippet that
-- sends a stored video (public chat-media URL) instead of text or an
-- interactive message. Picked from the inbox composer like any other
-- snippet; the stored media is never re-uploaded per send, and there
-- is no fresh Storage path to GC, so the URL lives purely in
-- `media_url`.
--
-- Extends the set of columns migration 035 introduced. The kind CHECK
-- is widened to accept 'video' — per-row semantics:
--   'text'        → content_text
--   'interactive' → interactive_payload
--   'video'       → media_url + media_name + media_type
--   'video'       → media_path (storage object path the snippet owns —
--                  used only to GC the object when the snippet is
--                  deleted; never a per-send upload, which carries no
--                  fresh path to clean up)
-- ============================================================

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_name TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_path TEXT;

-- Widen the kind CHECK to include 'video'. Postgres has no
-- "add value to CHECK" — drop + re-add with the new list. Existing
-- rows all satisfy the member list already, so the re-add is safe.
ALTER TABLE quick_replies
  DROP CONSTRAINT IF EXISTS quick_replies_kind_check;

ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_kind_check
  CHECK (kind IN ('text', 'interactive', 'video'));