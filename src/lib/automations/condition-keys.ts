import type { ConditionRule, ConditionStepConfig } from '@/types'

// ------------------------------------------------------------
// Condition branch-key conventions shared by the builder, the tree
// serializers, the validator and the engine.
//
// A condition block owns one child bucket per rule plus one for the
// ELSE / OTHER fallback:
//   - rule 0 (IF)        → bucket key `yes`   (back-compat with legacy
//                          single-condition automations)
//   - rule i ≥ 1 (ELSE-IF) → bucket key `b{i}` (`b1`, `b2`, …)
//   - no rule matched     → bucket key `no`   (back-compat ELSE)
//
// `branch_key` is stored explicitly on each rule so that removing an
// ELSE-IF never re-keys the branches after it (stable addressing).
// ------------------------------------------------------------

/** Bucket a condition routes to when no rule matched (ELSE / OTHER). */
export const CONDITION_ELSE_BRANCH_KEY = 'no'

export function defaultRuleBranchKey(index: number): string {
  return index === 0 ? 'yes' : `b${index}`
}

/**
 * The ordered branch keys a builder should render for a condition:
 * one bucket per rule (`yes`, `b1`, `b2`, …) plus the final ELSE bucket.
 */
export function conditionBranchKeys(cfg: ConditionStepConfig): string[] {
  const rules = Array.isArray(cfg.rules) && cfg.rules.length > 0 ? cfg.rules : []
  if (rules.length === 0) return ['yes', 'no']
  return [...rules.map((_, i) => defaultRuleBranchKey(i)), CONDITION_ELSE_BRANCH_KEY]
}

/**
 * The normalized rule set evaluated at runtime. Legacy configs (which
 * stored the single condition inline as subject/operand/value) become a
 * one-rule list routing to the `yes` bucket; multi-rule configs keep
 * their explicit `branch_key` (falling back to the index default).
 */
export function rulesFromConfig(cfg: ConditionStepConfig): ConditionRule[] {
  const rules = Array.isArray(cfg.rules) && cfg.rules.length > 0 ? cfg.rules : null
  if (rules) {
    return rules.map((r, i) => (r.branch_key ? r : { ...r, branch_key: defaultRuleBranchKey(i) }))
  }
  return [
    {
      subject: cfg.subject,
      operand: cfg.operand,
      operator: 'contains',
      value: cfg.value,
      branch_key: 'yes',
    },
  ]
}

/**
 * Next free auto branch key for a rule being appended. Scans the rules a
 * builder already holds so a removal doesn't leave a stride gap that
 * collides with a later `b{n}`.
 */
export function nextAutoRuleKey(existing: ConditionRule[]): string {
  const taken = new Set<string>()
  for (const r of existing) {
    if (r.branch_key) taken.add(r.branch_key)
    taken.add(defaultRuleBranchKey(0)) // `yes` is always claimed by IF
  }
  let i = 1
  while (taken.has(`b${i}`)) i++
  return `b${i}`
}