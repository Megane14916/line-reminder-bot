import { pushTimeoutMs, sendPush } from './line/client'
import { reminderSlots, ruleSchema } from './tasks/schedule'
import { daysUntil, todayInJapan } from './tasks/validation'

const minute = 60_000
const freshness = 60 * minute
const leaseMs = 2 * minute
const maxAttempts = 4
const scanLimit = 100
const sendLimit = 30
export const reminderCron = '* * * * *'

type ScheduledTask = {
  id: number; group_id: string; title: string; due_date: string; reminder_rule: string; reminder_anchor: number
  reminder_version: number; next_reminder_at: number
}
type Occurrence = { task_id: number; scheduled_at: number; group_id: string }
type Claim = { message_text: string; retry_key: string; attempt_count: number; lease_until: number }

// Retries stop at the earlier of one hour after the scheduled slot and midnight in Japan.
function earliestSlot(now: number) {
  const midnight = Date.parse(`${todayInJapan(now + pushTimeoutMs)}T00:00:00+09:00`)
  return Math.max(now + pushTimeoutMs - freshness + 1, midnight)
}

export async function runReminders({ DB, LINE_CHANNEL_ACCESS_TOKEN: accessToken }: Env, clock = Date.now) {
  const now = clock()
  const { results: tasks } = await DB.prepare(`SELECT id, group_id, title, due_date, reminder_rule, reminder_anchor,
    reminder_version, next_reminder_at FROM tasks WHERE status = 'open' AND deleted_at IS NULL AND reminder_enabled = 1
    AND next_reminder_at <= ? ORDER BY next_reminder_at, id LIMIT ?`).bind(now, scanLimit).all<ScheduledTask>()

  for (const task of tasks) {
    try {
      await enqueue(DB, task, clock())
    } catch {
      console.error('Reminder task failed', { stage: 'schedule', taskId: task.id })
    }
  }

  const readyAt = clock()
  const { results } = await DB.prepare(`SELECT o.task_id, o.scheduled_at, o.group_id FROM reminder_occurrences o
    JOIN tasks t ON t.id = o.task_id AND t.group_id = o.group_id AND t.reminder_version = o.rule_version
    WHERE o.status != 'sent' AND t.status = 'open' AND t.deleted_at IS NULL AND t.reminder_enabled = 1
      AND o.scheduled_at BETWEEN ? AND ? AND o.attempt_count < ? AND (
        (o.status = 'pending' AND (o.lease_until IS NULL OR o.lease_until <= ?)) OR
        (o.status = 'failed' AND o.next_attempt_at <= ?)
      ) ORDER BY o.scheduled_at, o.task_id LIMIT ?`)
    .bind(earliestSlot(readyAt), readyAt, maxAttempts, readyAt, readyAt, sendLimit).all<Occurrence>()
  if (results.length && !accessToken) throw new Error('LINE channel access token is not configured')
  for (const occurrence of results) {
    try {
      await deliver(DB, accessToken, occurrence, clock)
    } catch {
      console.error('Reminder task failed', { stage: 'delivery', taskId: occurrence.task_id, scheduledAt: occurrence.scheduled_at })
    }
  }
}

async function enqueue(db: D1Database, task: ScheduledTask, now: number) {
  const { id, group_id: group, reminder_version: version, next_reminder_at: slot } = task
  const rule = ruleSchema.parse(JSON.parse(task.reminder_rule))
  // Skip expired slots while keeping any later slots that are still eligible.
  const firstEligible = earliestSlot(now)
  const next = reminderSlots(rule, task.due_date, task.reminder_anchor, Math.max(slot, firstEligible - 1))[0] ?? null
  const current = `id = ? AND group_id = ? AND reminder_version = ? AND next_reminder_at = ?
    AND status = 'open' AND deleted_at IS NULL AND reminder_enabled = 1`
  const advance = db.prepare(`UPDATE tasks SET next_reminder_at = ? WHERE ${current}`).bind(next, id, group, version, slot)
  if (slot < firstEligible) {
    await advance.run()
    return
  }

  const days = daysUntil(task.due_date, slot)
  const text = days === 0 ? `今日が期限です：${task.title}`
    : days === 1 ? `明日が期限です：${task.title}` : `期限まであと${days}日です：${task.title}`
  const legacySlot = Date.parse(`${task.due_date}T20:00:00+09:00`) - 86_400_000
  const insert = db.prepare(`INSERT INTO reminder_occurrences (task_id, scheduled_at, group_id, rule_version, message_text, retry_key)
    SELECT id, ?, group_id, reminder_version, ?, ? FROM tasks WHERE ${current}
    AND (? != ? OR NOT EXISTS (SELECT 1 FROM notification_batches b WHERE b.group_id = tasks.group_id
      AND b.target_due_date = tasks.due_date AND (b.status IN ('sent', 'pending') OR b.http_status IS NULL OR b.http_status >= 500)))
    ON CONFLICT(task_id, scheduled_at) DO UPDATE SET rule_version = excluded.rule_version, message_text = excluded.message_text
      WHERE reminder_occurrences.attempt_count = 0`).bind(slot, text, crypto.randomUUID(), id, group, version, slot, slot, legacySlot)
  await db.batch([insert, advance])
}

async function deliver(db: D1Database, accessToken: string, occurrence: Occurrence, clock: () => number) {
  const { task_id: id, scheduled_at: slot, group_id: group } = occurrence
  const now = clock()
  const claim = await db.prepare(`UPDATE reminder_occurrences AS o SET status = 'pending', attempt_count = attempt_count + 1,
    last_attempt_at = ?, lease_until = ?, next_attempt_at = NULL, last_error_kind = 'unknown', http_status = NULL
    WHERE task_id = ? AND scheduled_at = ? AND group_id = ? AND scheduled_at >= ? AND scheduled_at <= ? AND attempt_count < ? AND (
      (status = 'pending' AND (lease_until IS NULL OR lease_until <= ?)) OR (status = 'failed' AND next_attempt_at <= ?)
    ) AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = o.task_id AND t.group_id = o.group_id AND t.reminder_version = o.rule_version
      AND t.status = 'open' AND t.deleted_at IS NULL AND t.reminder_enabled = 1)
    RETURNING message_text, retry_key, attempt_count, lease_until`)
    .bind(now, now + leaseMs, id, slot, group, earliestSlot(now), now, maxAttempts, now, now).first<Claim>()
  if (!claim) return
  const sendAt = clock()
  if (sendAt + pushTimeoutMs >= claim.lease_until || slot < earliestSlot(sendAt)) return

  const result = await sendPush(accessToken, group, claim.message_text, claim.retry_key)
  const completedAt = clock()
  const status = !result.ok && result.kind === 'http' ? result.status : null
  const next = result.ok ? null : retryAt(result, completedAt, slot, claim.attempt_count)
  if (!result.ok) console.error('LINE reminder failed', { taskId: id, scheduledAt: slot, kind: result.kind, status, attempt: claim.attempt_count })
  // Save already accepted sends even if a concurrent edit invalidated future deliveries.
  await db.prepare(`UPDATE reminder_occurrences SET status = ?, sent_at = ?, line_message_id = ?, http_status = ?,
    lease_until = NULL, last_error_kind = ?, next_attempt_at = ?
    WHERE task_id = ? AND scheduled_at = ? AND group_id = ? AND status = 'pending' AND attempt_count = ?`)
    .bind(result.ok ? 'sent' : 'failed', result.ok ? completedAt : null, result.ok ? result.messageId ?? null : null,
      status, result.ok ? null : result.kind, next, id, slot, group, claim.attempt_count).run()
}

function retryAt(result: Extract<Awaited<ReturnType<typeof sendPush>>, { ok: false }>, now: number, slot: number, attempt: number) {
  if (attempt >= maxAttempts) return null
  let delay = 5 * minute * 2 ** (attempt - 1)
  if (result.kind === 'http') {
    if (result.status === 429) {
      const after = result.retryAfter?.trim() ?? ''
      const requested = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now
      delay = Math.max(delay, 15 * minute, Number.isNaN(requested) ? 0 : requested)
    } else if (result.status < 500 || result.status >= 600) return null
  }
  const next = now + delay
  return slot >= earliestSlot(next) ? next : null
}
