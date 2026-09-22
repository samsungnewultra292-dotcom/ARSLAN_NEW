// ============================================================
// Blocklist — CRM-level phone blocking shared by every outbound
// send path AND the inbound webhook (migration 045).
//
// The key is the NORMALIZED phone number (digits only), so a block
// set from the thread header ("+1 555 123 4567") also matches a
// webhook / send carrying "15551234567".
//
// Fail-open on DB errors: a blocklist query failure must never take
// down a send or drop an inbound message. The worst case is a blocked
// number slipping through — the table is tiny (one indexed lookup),
// so this only matters under real DB trouble.
// ============================================================

import { normalizePhone } from './phone-utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/**
 * True when `phone` is on the account's blocklist.
 *
 * Deliberately accepts any Supabase-shaped client: the webhook passes
 * its lazy service-role `any`, the send cores pass their typed
 * `SupabaseClient`. Phone is normalized inside — callers may pass
 * whatever format they hold.
 */
export async function isPhoneBlocked(
  db: Db,
  accountId: string,
  phone: string,
): Promise<boolean> {
  const normalized = normalizePhone(phone)
  if (!normalized) return false // BSUID-only sender — can't match.
  try {
    const { data, error } = await db
      .from('blocked_numbers')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone_normalized', normalized)
      .maybeSingle()
    if (error) {
      console.warn(
        '[blocklist] block check failed (fail-open):',
        error.message ?? error,
      )
      return false
    }
    return Boolean(data)
  } catch (err) {
    console.warn(
      '[blocklist] block check threw (fail-open):',
      err instanceof Error ? err.message : err,
    )
    return false
  }
}