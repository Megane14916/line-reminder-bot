import { pushTimeoutMs, sendPush } from './line/client'
import type { TaskCategory } from './tasks/repository'
import { todayInJapan } from './tasks/validation'

const dayMs = 24 * 60 * 60 * 1000
const maxTextLength = 5000
const leaseMs = 2 * 60 * 1000
const retryDelayMs = 5 * 60 * 1000
const maxAttempts = 4

export const deadlineCron = '0 11 * * *'
export const retryCron = '*/5 * * * *'

type ReminderTask = { group_id: string; category: TaskCategory; title: string }
type Batch = { group_id: string; target_due_date: string; retry_key: string }
type ClaimedBatch = { message_text: string; attempt_count: number; created_at: number; lease_until: number }

export async function sendDeadlineReminders({ DB, LINE_CHANNEL_ACCESS_TOKEN: accessToken }: Env, scheduledTime: number) {
  const targetDate = todayInJapan(scheduledTime + dayMs)
  const { results } = await DB.prepare(`
    SELECT group_id, category, title FROM tasks
    WHERE status = 'open' AND due_date = ? AND created_at <= ?
    ORDER BY group_id, id
  `).bind(targetDate, scheduledTime).all<ReminderTask>()
  if (!results.length) return
  if (!accessToken) throw new Error('LINE channel access token is not configured')

  const groups = new Map<string, ReminderTask[]>()
  for (const task of results) {
    const tasks = groups.get(task.group_id)
    if (tasks) tasks.push(task)
    else groups.set(task.group_id, [task])
  }

  for (const [groupId, tasks] of groups) {
    const text = formatReminder(targetDate, tasks)
    const retryKey = crypto.randomUUID()
    let inserted
    try {
      inserted = await DB.prepare(`
        INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (group_id, target_due_date) DO NOTHING
      `).bind(groupId, targetDate, text, retryKey, Date.now()).run()
    } catch {
      logD1Failure('insert', targetDate, retryKey)
      continue
    }
    if (inserted.meta.changes) {
      await attemptDelivery(DB, accessToken, { group_id: groupId, target_due_date: targetDate, retry_key: retryKey })
    }
  }
}

export async function retryDeadlineReminders({ DB, LINE_CHANNEL_ACCESS_TOKEN: accessToken }: Env) {
  const now = Date.now()
  const { results } = await DB.prepare(`
    SELECT group_id, target_due_date, retry_key FROM notification_batches
    WHERE attempt_count < ? AND created_at > ? AND (
      (status = 'pending' AND (lease_until IS NULL OR lease_until <= ?))
      OR (status = 'failed' AND next_attempt_at <= ?)
    ) ORDER BY created_at, group_id
  `).bind(maxAttempts, now + pushTimeoutMs - dayMs, now, now).all<Batch>()
  if (!results.length) return
  if (!accessToken) throw new Error('LINE channel access token is not configured')

  for (const batch of results) await attemptDelivery(DB, accessToken, batch)
}

async function attemptDelivery(db: D1Database, accessToken: string, batch: Batch) {
  const { group_id: groupId, target_due_date: targetDate, retry_key: retryKey } = batch
  const now = Date.now()
  let claim: ClaimedBatch | null
  try {
    // The conditional update gives one invocation the lease and counts even interrupted attempts.
    claim = await db.prepare(`
      UPDATE notification_batches SET status = 'pending', attempt_count = attempt_count + 1,
        last_attempt_at = ?, lease_until = ?, next_attempt_at = NULL, last_error_kind = 'unknown', http_status = NULL
      WHERE group_id = ? AND target_due_date = ? AND retry_key = ? AND attempt_count < ? AND created_at > ? AND (
        (status = 'pending' AND (lease_until IS NULL OR lease_until <= ?))
        OR (status = 'failed' AND next_attempt_at <= ?)
      ) RETURNING message_text, attempt_count, created_at, lease_until
    `).bind(now, now + leaseMs, groupId, targetDate, retryKey, maxAttempts, now + pushTimeoutMs - dayMs, now, now)
      .first<ClaimedBatch>()
  } catch {
    logD1Failure('claim', targetDate, retryKey)
    return
  }
  if (!claim) return

  // Leave room for the request timeout before either the lease or retry window ends.
  const expiresAt = claim.created_at + dayMs
  if (Date.now() + pushTimeoutMs >= Math.min(expiresAt, claim.lease_until)) return

  let result: Awaited<ReturnType<typeof sendPush>>
  try {
    result = await sendPush(accessToken, groupId, claim.message_text, retryKey)
  } catch {
    console.error('Deadline reminder group failed', { targetDate, retryKey, stage: 'send', kind: 'unexpected' })
    return
  }
  const completedAt = Date.now()
  const httpStatus = !result.ok && result.kind === 'http' ? result.status : null
  const nextAttempt = result.ok ? null : nextRetryAt(result, completedAt, claim.attempt_count, expiresAt)
  if (!result.ok) {
    console.error('LINE deadline reminder failed', { retryKey, targetDate, kind: result.kind, httpStatus, attempt: claim.attempt_count })
  }

  try {
    // The attempt count fences off a late result from a former lease holder.
    await db.prepare(`
      UPDATE notification_batches SET status = ?, http_status = ?, sent_at = ?, lease_until = NULL,
        next_attempt_at = ?, last_error_kind = ?
      WHERE group_id = ? AND target_due_date = ? AND status = 'pending' AND attempt_count = ?
    `).bind(result.ok ? 'sent' : 'failed', httpStatus, result.ok ? completedAt : null,
      nextAttempt, result.ok ? null : result.kind, groupId, targetDate, claim.attempt_count).run()
  } catch {
    logD1Failure('save_result', targetDate, retryKey)
  }
}

function nextRetryAt(result: Extract<Awaited<ReturnType<typeof sendPush>>, { ok: false }>, now: number, attempt: number, expiresAt: number) {
  if (attempt >= maxAttempts) return null
  let delay = retryDelayMs * 2 ** (attempt - 1)
  if (result.kind === 'http') {
    if (result.status === 429) {
      const after = result.retryAfter?.trim() ?? ''
      const retryAfterMs = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now
      delay = Math.max(delay, 15 * 60 * 1000, Number.isNaN(retryAfterMs) ? 0 : retryAfterMs)
    } else if (result.status < 500 || result.status >= 600) {
      return null
    }
  }
  const next = now + delay
  return next + pushTimeoutMs < expiresAt ? next : null
}

function logD1Failure(stage: 'insert' | 'claim' | 'save_result', targetDate: string, retryKey: string) {
  console.error('Deadline reminder group failed', { targetDate, retryKey, stage, kind: 'd1' })
}

function formatReminder(targetDate: string, tasks: ReminderTask[]) {
  let text = `明日（${targetDate}）が期限のタスク（${tasks.length}件）`
  for (const [index, task] of tasks.entries()) {
    const category = task.category === 'deadline' ? '期限' : '持ち物'
    const line = `\n・［${category}］${task.title}`
    const remaining = tasks.length - index
    if (text.length + line.length + `\nほか${remaining}件`.length > maxTextLength) {
      return `${text}\nほか${remaining}件`
    }
    text += line
  }
  return text
}
