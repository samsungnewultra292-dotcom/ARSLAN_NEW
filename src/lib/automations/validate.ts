import type { AutomationTriggerType } from '@/types'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: Record<string, StepLike[]>
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      // Branch buckets are keyed `yes` (IF), `b1`, `b2`, … (ELSE-IF) and
      // `no` (ELSE/OTHER); walk every bucket with stable dot-paths.
      for (const [key, kids] of Object.entries(s.branches)) {
        if (Array.isArray(kids)) walk(kids, `${path}.${key}.`, issues)
      }
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      validateSendMessage(c, path, issues)
      break
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c)
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error })
      }
      break
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required' })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0' })
      }
      if (!['seconds', 'minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be seconds, minutes, hours, or days',
        })
      }
      break
    case 'condition': {
      const rules = Array.isArray(c.rules) && c.rules.length > 0 ? (c.rules as ConditionRuleLike[]) : null
      if (rules) {
        rules.forEach((r, i) => validateConditionRule(r, `${path}.rules[${i}]`, issues))
      } else {
        // Legacy single-rule config stored subject/operand inline.
        if (!nonEmpty(c.subject)) {
          issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
        }
        if (!nonEmpty(c.operand)) {
          issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
        }
      }
      break
    }
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (
      cfg.match_type != null &&
      cfg.match_type !== 'exact' &&
      cfg.match_type !== 'contains' &&
      cfg.match_type !== 'word'
    ) {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact", "contains" or "word"',
      })
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({ path: 'trigger.schedule', message: 'schedule is required' })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' })
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      })
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
      })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

// ------------------------------------------------------------
// send_message step config (v0.9): optional image/video, up to 3 quick
// replies (native Meta interactive buttons) + any number of URL buttons
// (rendered as tappable link lines in the text body). Mirrors the
// runtime checks in engine.ts's send_message case.
// ------------------------------------------------------------

interface MediaLike {
  kind?: unknown
  url?: unknown
  name?: unknown
}

interface ButtonLike {
  type?: unknown
  id?: unknown
  title?: unknown
  value?: unknown
  url?: unknown
}

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.trim() === '') return false
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function validateSendMessage(
  c: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  const text = c.text
  const media = (c.media ?? undefined) as MediaLike | undefined
  const hasMedia = Boolean(media && nonEmpty(media.url))
  const buttons = Array.isArray(c.buttons)
    ? (c.buttons as ButtonLike[])
    : []
  const quickReplies = buttons.filter((b) => b.type === 'quick_reply')
  const urlButtons = buttons.filter((b) => b.type === 'url')

  // Optional media must be fully specified when declared.
  if (media && !hasMedia) {
    issues.push({ path: `${path}.media.url`, message: 'media URL is required' })
  }
  if (hasMedia) {
    if (media!.kind !== 'image' && media!.kind !== 'video') {
      issues.push({ path: `${path}.media.kind`, message: 'media kind must be image or video' })
    } else if (!isHttpUrl(media!.url)) {
      issues.push({ path: `${path}.media.url`, message: 'media URL must be a valid URL' })
    }
    if (nonEmpty(text) && String(text).length > 1024) {
      issues.push({ path: `${path}.text`, message: 'media caption exceeds the 1024-character limit' })
    }
  }

  // Quick replies → native Meta interactive buttons (1–3, ≤20 chars).
  quickReplies.forEach((b) => {
    if (!nonEmpty(b.title)) {
      issues.push({ path: `${path}.buttons.title`, message: 'quick reply title is required' })
    } else if (String(b.title).length > 20) {
      issues.push({ path: `${path}.buttons.title`, message: 'quick reply title exceeds 20 characters' })
    }
    if (!nonEmpty(b.id)) {
      issues.push({ path: `${path}.buttons.id`, message: 'quick reply id is required' })
    }
  })
  if (quickReplies.length > 3) {
    issues.push({ path: `${path}.buttons`, message: 'send_message supports at most 3 quick replies' })
  }

  // URL buttons → tappable link line in the text body; no Meta cap.
  urlButtons.forEach((b) => {
    if (!isHttpUrl(b.url)) {
      issues.push({ path: `${path}.buttons.url`, message: 'url button needs a valid URL' })
    }
  })

  const hasText = nonEmpty(text)
  if (!hasText && !hasMedia && quickReplies.length === 0 && urlButtons.length === 0) {
    issues.push({ path: `${path}.text`, message: 'message text is required' })
  }

  // Quick replies fly inside an interactive message, which needs a body.
  // When media already carries the text as its caption, only URL-button
  // lines provide the body.
  if (quickReplies.length > 0) {
    const links = urlButtons.filter((b) => isHttpUrl(b.url)).map((b) => String(b.url))
    const bodyParts = hasMedia && links.length > 0 ? links : [hasText ? text : '', ...links]
    if (bodyParts.join('\n').trim() === '') {
      issues.push({
        path: `${path}.buttons`,
        message: 'quick replies need body text (message text or a URL button)',
      })
    }
  }
}

interface ConditionRuleLike {
  subject?: unknown
  operand?: unknown
  operator?: unknown
  value?: unknown
  branch_key?: unknown
}

function validateConditionRule(r: ConditionRuleLike, path: string, issues: ValidationIssue[]): void {
  if (!['contact_field', 'tag_presence', 'message_content', 'time_of_day'].includes(String(r.subject))) {
    issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
    return
  }
  const subject = String(r.subject)
  if (subject === 'message_content') {
    const op = r.operator ?? 'contains'
    if (!['contains', 'exact', 'word'].includes(String(op))) {
      issues.push({ path: `${path}.operator`, message: 'operator must be contains, exact, or word' })
    }
    if (!nonEmpty(r.value)) {
      issues.push({ path: `${path}.value`, message: 'condition value is required' })
    }
  } else if (subject === 'contact_field') {
    if (!nonEmpty(r.operand)) {
      issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
    }
    if (r.value === undefined || r.value === null || r.value === '') {
      issues.push({ path: `${path}.value`, message: 'condition value is required' })
    }
  } else {
    // tag_presence / time_of_day use `operand` (tag id / time window).
    if (!nonEmpty(r.operand)) {
      issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
    }
  }
}
