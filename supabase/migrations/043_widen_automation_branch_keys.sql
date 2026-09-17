-- ============================================================
-- 043 — widen automation branch keys for multi-condition (IF →
-- ELSE-IF → ELSE) routing.
--
-- Condition steps used to own exactly two child buckets (`yes` for
-- IF, `no` for ELSE/OTHER). The automations step-builder now supports
-- sequential conditions: rule 0 (IF) routes to `yes`, rule i ≥ 1
-- (ELSE-IF) routes to `b{i}`, and no-match falls through to `no`.
-- Both tables that persist branch keys therefore need to accept the
-- `b1..bN` keys, otherwise saving an automation with an ELSE-IF
-- branch (or resuming a pending execution parked in one) is rejected
-- by the CHECK constraint.
-- ============================================================

ALTER TABLE automation_steps
  DROP CONSTRAINT IF EXISTS automation_steps_branch_check;

ALTER TABLE automation_steps
  ADD CONSTRAINT automation_steps_branch_check
    CHECK (
      branch IS NULL
      OR branch IN ('yes', 'no')
      OR branch ~ '^b[0-9]+$'
    );

ALTER TABLE automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_branch_check;

ALTER TABLE automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_branch_check
    CHECK (
      branch IS NULL
      OR branch IN ('yes', 'no')
      OR branch ~ '^b[0-9]+$'
    );