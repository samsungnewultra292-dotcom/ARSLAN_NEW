import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// CRM-level blocklist (migration 045). GET lists the account's blocked
// numbers; POST blocks a phone (idempotent — a duplicate normalized
// number is a no-op, not an error); DELETE unblocks. Mutations are
// scoped to agent+ via requireRole, reads to any account member.

interface BlockedNumberRow {
  id: string
  phone_normalized: string
  display_phone: string
  created_at: string
}

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (blocked_numbers_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('blocked_numbers')
      .select('id, phone_normalized, display_phone, created_at')
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ blocked_numbers: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const normalized = normalizePhone(rawPhone)
  if (!normalized) {
    return NextResponse.json(
      { error: 'A valid phone number is required' },
      { status: 400 },
    )
  }

  // Insert. The unique (account_id, phone_normalized) index makes a
  // re-block a conflict rather than a duplicate row — treat that as
  // success so "Block" is idempotent from the UI.
  const { data, error } = await ctx.supabase
    .from('blocked_numbers')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      phone_normalized: normalized,
      display_phone: rawPhone,
    })
    .select('id')
    .maybeSingle()

  if (!error && data) {
    return NextResponse.json({ blocked: true, id: data.id }, { status: 200 })
  }
  if (error && isUniqueViolation(error)) {
    return NextResponse.json({ blocked: true }, { status: 200 })
  }
  return NextResponse.json({ error: error?.message ?? 'Failed to block number' }, { status: 500 })
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : body.phone_normalized ?? ''
  const normalized = normalizePhone(rawPhone)
  if (!normalized) {
    return NextResponse.json(
      { error: 'A valid phone number is required' },
      { status: 400 },
    )
  }

  // Also accept the normalized form directly (the UI holds the row's
  // phone_normalized); normalizePhone is identity for digits-only.
  const { error } = await ctx.supabase
    .from('blocked_numbers')
    .delete()
    .eq('account_id', ctx.accountId)
    .eq('phone_normalized', normalized)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ unblocked: true }, { status: 200 })
}

export type { BlockedNumberRow }