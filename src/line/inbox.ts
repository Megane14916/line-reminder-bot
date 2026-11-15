import { intentSchema, type TaskAction } from '../tasks/intent'
import { answerSelection, clarify, dispatchAction, help } from '../tasks/actions'
import { finishInboxEvent, getQuotedTask, wasProcessed, type TaskEvent } from '../tasks/repository'
import { sendReply } from './client'
import { inferenceTimeoutMs, parseIntent } from './intent-parser'

export type Input = { type: 'intent'; text: string } | { type: 'quote'; messageId: string } | { type: 'selection'; id: number }
export type Operation = Omit<TaskEvent, 'now' | 'inbox'> & { replyToken: string; input: Input }
type Entry = { receipt_id: number; group_id: string }
type Claimed = Entry & {
  event_id: string; user_id: string; event_time: number; received_at: number; reply_token: string
  input_json: string; action_json: string | null; attempts: number
}
type InboxEvent = TaskEvent & { inbox: NonNullable<TaskEvent['inbox']> }

const maxAttempts = 3
const retention = 15 * 60_000
const leaseMs = 45_000
const budgetMs = 25_000
const groupLimit = 4
const perGroupLimit = 2
const intakeBatch = 25

export async function acceptEvents(db: D1Database, operations: Operation[], now: number) {
  for (let i = 0; i < operations.length; i += intakeBatch) {
    await db.batch(operations.slice(i, i + intakeBatch).map((operation) => db.prepare(`
      INSERT INTO webhook_inbox(event_id, group_id, user_id, event_time, received_at, input_json, reply_token, available_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id = ?)
      ON CONFLICT(event_id) DO NOTHING
    `).bind(operation.eventId, operation.groupId, operation.userId, operation.eventTime, now,
      JSON.stringify(operation.input), operation.replyToken, now, operation.eventId)))
  }
}

const head = `NOT EXISTS (SELECT 1 FROM webhook_inbox older WHERE older.group_id = q.group_id
  AND older.status IN ('queued', 'running') AND (older.event_time, older.receipt_id) < (q.event_time, q.receipt_id))`
const unlocked = `NOT EXISTS (SELECT 1 FROM webhook_inbox active WHERE active.group_id = q.group_id
  AND active.status = 'running' AND active.lease_until > ?)`
const ready = `q.status IN ('queued', 'running') AND q.available_at <= ?
  AND (q.lease_until IS NULL OR q.lease_until <= ?) AND q.attempts < ? AND q.received_at > ?`

export async function drainInbox(env: Env, clock = Date.now) {
  const db = env.DB
  const start = clock()
  const deadline = start + budgetMs
  // Terminalize an abandoned last attempt or an expired queue entry, keeping only metadata.
  await db.prepare(`UPDATE webhook_inbox SET status = 'failed', last_error = CASE
      WHEN received_at <= ? THEN 'expired' ELSE COALESCE(last_error, 'abandoned') END,
    finished_at = ?, input_json = NULL, action_json = NULL, reply_token = NULL, lease_token = NULL, lease_until = NULL
    WHERE receipt_id IN (SELECT receipt_id FROM webhook_inbox WHERE status IN ('queued', 'running')
      AND (received_at <= ? OR attempts >= ?) AND (lease_until IS NULL OR lease_until <= ?) LIMIT 25)`)
    .bind(start - retention, start, start - retention, maxAttempts, start).run()

  const { results } = await db.prepare(`SELECT q.receipt_id, q.group_id FROM webhook_inbox q
    WHERE ${ready} AND ${head} AND ${unlocked} ORDER BY q.available_at, q.receipt_id LIMIT ?`)
    .bind(start, start, maxAttempts, start - retention, start, groupLimit).all<Entry>()

  const replies: Promise<void>[] = []
  await Promise.all(results.map(async (entry) => {
    try {
      for (let i = 0; i < perGroupLimit; i++) {
        const now = clock()
        if (deadline - now < inferenceTimeoutMs + 1000) break
        const token = crypto.randomUUID()
        const row = await claim(db, entry.group_id, token, now)
        if (!row) break
        const event: InboxEvent = { groupId: row.group_id, userId: row.user_id, eventId: row.event_id,
          eventTime: row.event_time, now, inbox: { receiptId: row.receipt_id, leaseToken: token } }
        const reply = await processEvent(env, row, event, clock)
        const timeLeft = deadline - clock()
        if (reply && timeLeft > 0 && clock() - row.received_at < 50_000 && clock() - row.event_time < 20 * 60_000) {
          replies.push(deliverReply(env.LINE_CHANNEL_ACCESS_TOKEN, row, reply, Math.min(timeLeft, 10_000)))
        }
      }
    } catch {
      console.error('LINE inbox group could not advance', { receiptId: entry.receipt_id })
    }
  }))
  await Promise.all(replies)
}

function claim(db: D1Database, groupId: string, token: string, now: number) {
  return db.prepare(`UPDATE webhook_inbox SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?
    WHERE receipt_id = (SELECT q.receipt_id FROM webhook_inbox q WHERE q.group_id = ?
      AND ${ready} AND ${head} AND ${unlocked} LIMIT 1)
    RETURNING receipt_id, event_id, group_id, user_id, event_time, received_at, reply_token, input_json, action_json, attempts`)
    .bind(token, now + leaseMs, groupId, now, now, maxAttempts, now - retention, now).first<Claimed>()
}

async function processEvent(env: Env, row: Claimed, event: InboxEvent, clock: () => number) {
  const db = env.DB
  try {
    const stale = await db.prepare(`SELECT 1 AS stale FROM webhook_group_progress WHERE group_id = ?
      AND (event_time, receipt_id) > (?, ?)`).bind(event.groupId, event.eventTime, row.receipt_id).first()
    if (stale) {
      if (await finishInboxEvent(db, event, false, 'out_of_order')) return '先に新しい操作が反映されたため、古い操作は保留せず終了しました。必要ならもう一度送ってください。'
      return
    }

    const input: Input = JSON.parse(row.input_json)
    let action: TaskAction | undefined
    let reply: string | undefined
    let failure: string | undefined
    if (input.type === 'selection') {
      reply = await answerSelection(db, event, input.id)
    } else if (input.type === 'quote') {
      const id = await getQuotedTask(db, event.groupId, input.messageId)
      if (id) action = { type: 'complete_task', target: { by: 'id', id } }
    } else if (!input.text) {
      reply = help
    } else {
      if (row.action_json) action = intentSchema.parse(JSON.parse(row.action_json))
      else {
        const parsed = await parseIntent(env.AI, env.AI_MODEL, input.text, event.eventTime)
        if (parsed.kind === 'timeout' || parsed.kind === 'unavailable') {
          const stopped = await retryEvent(db, row, event, clock(), 'ai_' + parsed.kind)
          return stopped ? 'AI の処理を完了できませんでした。タスクの状態を確認し、必要ならもう一度送ってください。' : undefined
        }
        if (parsed.kind === 'parsed') {
          action = authorizeIntent(parsed.action, input.text)
          if (action) {
            const saved = await db.prepare(`UPDATE webhook_inbox SET action_json = ? WHERE receipt_id = ?
              AND status = 'running' AND lease_token = ? AND lease_until > ?`)
            .bind(JSON.stringify(action), row.receipt_id, event.inbox.leaseToken, clock()).run()
            if (!saved.meta.changes) return
          }
        }
      }
      if (!action || action.type === 'unknown' || action.type === 'clarify') {
        failure = 'invalid_intent'
        reply = action?.type === 'clarify' ? clarify : '操作を読み取れませんでした。日付やタスク名を添えて、もう一度お試しください。'
        action = undefined
      }
    }

    event.now = clock()
    if (action) reply = await dispatchAction(db, event, action)
    // Mutating actions already commit the Inbox result with their D1 batch.
    if (await wasProcessed(db, event.eventId)) return reply
    if (await finishInboxEvent(db, event, !!action && action.type !== 'help', failure)) return reply
  } catch {
    if (await retryEvent(db, row, event, clock(), 'd1_error')) {
      return '処理結果を確認できませんでした。もう一度送る前にタスク一覧を確認してください。'
    }
  }
}

function authorizeIntent(action: TaskAction, text: string) {
  if ('target' in action) {
    if (action.target.by === 'id' && !text.normalize('NFKC').match(/#[0-9]+/g)?.includes('#' + action.target.id)) return
    if (action.target.by === 'name' && !text.includes(action.target.name)) return
    if (action.target.by === 'recent' && !action.type.includes('reminder') && !/さっき|やっぱり|このタスク|そのタスク|前のタスク|今のタスク/.test(text)) return
  }
  return action
}

async function retryEvent(db: D1Database, row: Claimed, event: InboxEvent, now: number, reason: string) {
  const terminal = row.attempts >= maxAttempts || now - row.received_at >= retention
  console.error('LINE inbox attempt failed', { eventId: row.event_id, attempt: row.attempts, reason })
  if (terminal) return !!await finishInboxEvent(db, { ...event, now }, false, reason)
  await db.prepare(`UPDATE webhook_inbox SET status = 'queued', available_at = ?, last_error = ?, lease_token = NULL, lease_until = NULL
    WHERE receipt_id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`)
    .bind(now + (row.attempts === 1 ? 15_000 : 60_000), reason, row.receipt_id, event.inbox.leaseToken, now).run()
  return false
}

async function deliverReply(accessToken: string, row: Claimed, reply: string, timeoutMs: number) {
  try {
    const result = await sendReply(accessToken, row.reply_token, reply, timeoutMs)
    if (!result.ok) console.error('LINE inbox reply failed', { eventId: row.event_id, kind: result.kind,
      status: result.kind === 'http' ? result.status : undefined })
  } catch {
    console.error('LINE inbox reply failed', { eventId: row.event_id, kind: 'unexpected' })
  }
}
