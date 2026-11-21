import { retryDelay, sendPush, sendReply, type SendResult } from './client'
import { lineTimeout, type RuntimeBudget } from '../runtime-budget'

export type OperationResult = string | { changed: string; unchanged: string }
const retentionMs = 60 * 60_000
const leaseMs = 45_000
const maxPushAttempts = 4
const dbReserveMs = 1000
const minReplyWindowMs = 2000

export const unknownOperation = '先ほどの操作結果を確認できませんでした。タスク一覧を確認してください。'
export const failedInference = '先ほどの操作を完了できませんでした。もう一度お試しください。'

type Delivery = {
  event_id: string; group_id: string; text: string; reply_token: string | null; retry_key: string
  reply_until: number; expires_at: number; push_attempts: number; status: 'replying' | 'pushing'
}

export function saveOperationResult(db: D1Database, receiptId: number, message: OperationResult, now: number, forcePush: boolean,
  linkTask: boolean, threadId?: string, question = false, messageId?: string) {
  const body = typeof message === 'string' ? '?' : 'CASE WHEN changes() = 1 THEN ? ELSE ? END'
  return db.prepare(`INSERT INTO operation_result_outbox
    (event_id, group_id, text, reply_token, reply_until, retry_key, status, available_at, expires_at, task_id, thread_id, thread_question, trigger_message_id)
    SELECT event_id, group_id, ${body}, CASE WHEN ? THEN NULL ELSE reply_token END,
      min(received_at + 50000, event_time + 1190000), ?,
      CASE WHEN ? THEN 'push_pending' ELSE 'reply_pending' END, ?, ?,
      CASE WHEN ? AND changes() = 1 THEN (SELECT task_id FROM task_contexts WHERE group_id = q.group_id AND user_id = q.user_id) END,
      ${typeof message === 'string' ? '?' : 'CASE WHEN changes() = 1 THEN ? END'}, ?, ?
    FROM webhook_inbox q WHERE receipt_id = ?`)
    .bind(...(typeof message === 'string' ? [message] : [message.changed, message.unchanged]),
      Number(forcePush), crypto.randomUUID(), Number(forcePush), now, now + retentionMs, Number(linkTask), threadId ?? null, Number(question),
      messageId ?? null, receiptId)
}

// Inbox expiry and its user-facing outcome commit together, even if no worker reaches the last attempt.
export function expiredOperationResults(db: D1Database, expired: string, now: number, bindings: number[]) {
  return db.prepare(`INSERT INTO operation_result_outbox (event_id, group_id, text, reply_until, retry_key, status, available_at, expires_at)
    SELECT event_id, group_id, ?,
      0, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) ||
      '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
      'push_pending', ?, ?
    FROM webhook_inbox WHERE receipt_id IN (${expired}) AND json_extract(input_json, '$.type') IN ('intent', 'quote', 'followup')
    ON CONFLICT(event_id) DO NOTHING`)
    .bind(unknownOperation, now, now + retentionMs, ...bindings)
}

export async function drainResults(env: Env, budget: RuntimeBudget, eventId?: string) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || budget.remaining() <= dbReserveMs) return
  const now = budget.clock()
  const db = env.DB
  if (!eventId) {
    await db.prepare(`UPDATE operation_result_outbox SET status = CASE WHEN status IN ('replying', 'pushing') THEN 'uncertain' ELSE 'failed' END,
      last_error = CASE WHEN status = 'replying' THEN 'reply_interrupted'
        WHEN status = 'pushing' AND push_attempts >= ? THEN 'push_interrupted' ELSE 'expired' END,
      text = NULL, reply_token = NULL, lease_until = NULL, lease_token = NULL, finished_at = ?
      WHERE event_id IN (SELECT event_id FROM operation_result_outbox WHERE status IN ('reply_pending', 'replying', 'push_pending', 'pushing')
        AND (lease_until IS NULL OR lease_until <= ?) AND (expires_at <= ? OR status = 'replying'
          OR (status = 'pushing' AND push_attempts >= ?)) LIMIT 25)`)
      .bind(maxPushAttempts, now, now, now, maxPushAttempts).run()
  }
  if (budget.remaining() <= dbReserveMs) return
  const { results } = await db.prepare(`SELECT event_id FROM operation_result_outbox
    WHERE status IN ('reply_pending', 'push_pending', 'pushing') AND available_at <= ? AND expires_at > ?
      AND (lease_until IS NULL OR lease_until <= ?) AND push_attempts < ? AND (? IS NULL OR event_id = ?)
    ORDER BY available_at, event_id LIMIT 4`).bind(now, now, now, maxPushAttempts, eventId ?? null, eventId ?? null)
    .all<{ event_id: string }>()
  await Promise.all(results.map(async ({ event_id }) => {
    try {
      await deliverResult(env, event_id, budget)
    } catch {
      console.error('LINE operation result delivery failed', { eventId: event_id, stage: 'd1' })
    }
  }))
}

async function deliverResult(env: Env, id: string, budget: RuntimeBudget) {
  if (budget.remaining() <= dbReserveMs + minReplyWindowMs) return
  const now = budget.clock()
  const useReplyUntil = now + minReplyWindowMs
  const token = crypto.randomUUID()
  const db = env.DB
  const row = await db.prepare(`UPDATE operation_result_outbox SET
    status = CASE WHEN status = 'reply_pending' AND reply_token IS NOT NULL AND reply_until > ? THEN 'replying' ELSE 'pushing' END,
    channel = CASE WHEN status = 'reply_pending' AND reply_token IS NOT NULL AND reply_until > ? THEN 'reply' ELSE 'push' END,
    push_attempts = push_attempts + CASE WHEN status = 'reply_pending' AND reply_token IS NOT NULL AND reply_until > ? THEN 0 ELSE 1 END,
    reply_token = CASE WHEN status = 'reply_pending' AND reply_until > ? THEN reply_token ELSE NULL END,
    last_attempt_at = ?, lease_token = ?, lease_until = ?
    WHERE event_id = ? AND status IN ('reply_pending', 'push_pending', 'pushing') AND available_at <= ?
      AND expires_at > ? AND (lease_until IS NULL OR lease_until <= ?) AND push_attempts < ?
    RETURNING event_id, group_id, text, reply_token, retry_key, reply_until, expires_at, push_attempts, status`)
    .bind(useReplyUntil, useReplyUntil, useReplyUntil, useReplyUntil, now, token, now + leaseMs, id, now, now, now, maxPushAttempts).first<Delivery>()
  if (!row) return

  const reply = row.status === 'replying'
  const sendAt = budget.clock()
  const limit = lineTimeout(env)
  const timeout = Math.min(limit, budget.remaining() - dbReserveMs,
    (reply ? row.reply_until : row.expires_at) - sendAt, now + leaseMs - sendAt - dbReserveMs)
  if (timeout < Math.min(limit, 1000)) {
    // This worker knows no request was made. Requeue, or let the lease expire if D1 is unavailable.
    if (budget.remaining() > 0 && sendAt < now + leaseMs) await db.prepare(`UPDATE operation_result_outbox
      SET status = ?, push_attempts = push_attempts - ?, lease_token = NULL, lease_until = NULL
      WHERE event_id = ? AND lease_token = ?`).bind(reply ? 'reply_pending' : 'push_pending', Number(!reply), id, token).run()
    return
  }

  const access = env.LINE_CHANNEL_ACCESS_TOKEN
  if (reply && row.reply_token === null) throw new Error('Reply lease requires a token')
  const result = row.reply_token === null ? await sendPush(access, row.group_id, row.text, row.retry_key, timeout)
    : await sendReply(access, row.reply_token, row.text, timeout)
  if (budget.remaining() <= 0) return

  const completedAt = budget.clock()
  const { status, next, error } = deliveryOutcome(row, result, completedAt)
  if (error) console.error('LINE operation result attempt failed', { eventId: id, channel: reply ? 'reply' : 'push', error })
  await db.prepare(`UPDATE operation_result_outbox SET status = ?, available_at = ?, last_error = ?, finished_at = ?, line_message_id = ?,
    reply_token = NULL, text = CASE WHEN ? = 'push_pending' THEN text ELSE NULL END, lease_token = NULL, lease_until = NULL
    WHERE event_id = ? AND lease_token = ?`)
    .bind(status, next ?? completedAt, error, next === null ? completedAt : null, result.ok ? result.messageId ?? null : null, status, id, token).run()
}

function deliveryOutcome(row: Delivery, result: SendResult, now: number) {
  if (result.ok) return { status: 'sent', next: null, error: null }
  const error = result.kind === 'http' ? 'http_' + result.status : result.kind
  let delay: number | null
  if (row.status === 'replying') {
    if (result.kind !== 'http' || result.status < 400 || result.status >= 500 || result.status === 408) {
      return { status: 'uncertain', next: null, error }
    }
    delay = result.status === 429 ? retryDelay(result, now, 0) : 0
  } else {
    delay = row.push_attempts < maxPushAttempts ? retryDelay(result, now, 5 * 60_000 * 2 ** (row.push_attempts - 1)) : null
  }
  if (delay !== null && now + delay < row.expires_at) return { status: 'push_pending', next: now + delay, error }
  return { status: 'failed', next: null, error }
}
