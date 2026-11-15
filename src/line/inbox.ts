import { intentSchema, type TaskAction } from '../tasks/intent'
import { answerSelection, dispatchAction } from '../tasks/actions'
import { finishInboxEvent, getQuotedTask, wasProcessed, type TaskEvent } from '../tasks/repository'
import { aiTimeout, runtimeBudget, type RuntimeBudget } from '../runtime-budget'
import { parseIntent } from './intent-parser'
import { formatIntentError, helpMessage } from './messages'
import { drainResults, expiredOperationResults, failedInference, unknownOperation } from './outbox'

export type Input = { type: 'intent'; text: string } | { type: 'quote'; messageId: string } | { type: 'selection'; id: number }
export type Operation = Omit<TaskEvent, 'now' | 'inbox'> & { replyToken: string; input: Input }
type Entry = { receipt_id: number; group_id: string }
type Claimed = Entry & {
  event_id: string; user_id: string; event_time: number; received_at: number
  input_json: string; action_json: string | null; attempts: number
}
type InboxEvent = TaskEvent & { inbox: NonNullable<TaskEvent['inbox']> }

const maxAttempts = 3
const retention = 15 * 60_000
const leaseMs = 45_000
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

export async function drainInbox(env: Env, budget = runtimeBudget()) {
  const db = env.DB
  const { clock } = budget
  const start = clock()
  if (budget.remaining() <= 1000) return
  const expired = `SELECT receipt_id FROM webhook_inbox WHERE status IN ('queued', 'running')
    AND (received_at <= ? OR attempts >= ?) AND (lease_until IS NULL OR lease_until <= ?) ORDER BY receipt_id LIMIT 25`
  const expiry = [start - retention, maxAttempts, start]
  await db.batch([expiredOperationResults(db, expired, start, expiry), db.prepare(`UPDATE webhook_inbox SET status = 'failed', last_error = CASE
      WHEN received_at <= ? THEN 'expired' ELSE COALESCE(last_error, 'abandoned') END,
    finished_at = ?, input_json = NULL, action_json = NULL, reply_token = NULL, lease_token = NULL, lease_until = NULL
    WHERE receipt_id IN (${expired})`).bind(start - retention, start, ...expiry)])

  if (budget.remaining() <= 1000) return
  const { results } = await db.prepare(`SELECT q.receipt_id, q.group_id FROM webhook_inbox q
    WHERE ${ready} AND ${head} AND ${unlocked} ORDER BY q.available_at, q.receipt_id LIMIT ?`)
    .bind(start, start, maxAttempts, start - retention, start, groupLimit).all<Entry>()

  const deliveries: Promise<void>[] = []
  await Promise.all(results.map(async (entry) => {
    try {
      for (let i = 0; i < perGroupLimit; i++) {
        const now = clock()
        if (budget.remaining() < aiTimeout(env) + 3000) break
        const token = crypto.randomUUID()
        const row = await claim(db, entry.group_id, token, now)
        if (!row || budget.remaining() <= 1000) break
        const event: InboxEvent = { groupId: row.group_id, userId: row.user_id, eventId: row.event_id,
          eventTime: row.event_time, now, inbox: { receiptId: row.receipt_id, leaseToken: token, canCommit: () => budget.remaining() > 1000 } }
        await processEvent(env, row, event, budget)
        if (budget.remaining() > 1000) deliveries.push(drainResults(env, budget, event.eventId)
          .catch(() => console.error('LINE operation result scan failed', { eventId: event.eventId })))
      }
    } catch {
      console.error('LINE inbox group could not advance', { receiptId: entry.receipt_id })
    }
  }))
  await Promise.all(deliveries)
}

function claim(db: D1Database, groupId: string, token: string, now: number) {
  return db.prepare(`UPDATE webhook_inbox SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?
    WHERE receipt_id = (SELECT q.receipt_id FROM webhook_inbox q WHERE q.group_id = ?
      AND ${ready} AND ${head} AND ${unlocked} LIMIT 1)
    RETURNING receipt_id, event_id, group_id, user_id, event_time, received_at, input_json, action_json, attempts`)
    .bind(token, now + leaseMs, groupId, now, now, maxAttempts, now - retention, now).first<Claimed>()
}

async function processEvent(env: Env, row: Claimed, event: InboxEvent, budget: RuntimeBudget) {
  const db = env.DB
  const { clock } = budget
  const input: Input = JSON.parse(row.input_json)
  try {
    const stale = await db.prepare(`SELECT 1 AS stale FROM webhook_group_progress WHERE group_id = ?
      AND (event_time, receipt_id) > (?, ?)`).bind(event.groupId, event.eventTime, row.receipt_id).first()
    if (!event.inbox.canCommit()) return
    if (stale) {
      const reply = input.type === 'intent' && input.text ? '先に新しい操作が反映されたため、古い操作は反映されませんでした。必要ならもう一度送ってください。' : undefined
      await finishInboxEvent(db, { ...event, now: clock() }, false, reply, 'out_of_order')
      return
    }

    let action: TaskAction | undefined
    let reply: string | undefined
    let failure: string | undefined
    if (input.type === 'selection') {
      reply = await answerSelection(db, event, input.id)
    } else if (input.type === 'quote') {
      const id = await getQuotedTask(db, event.groupId, input.messageId)
      if (id) action = { type: 'complete_task', target: { by: 'id', id } }
    } else if (!input.text) {
      reply = helpMessage
    } else {
      if (row.action_json) action = intentSchema.parse(JSON.parse(row.action_json))
      else {
        const timeout = Math.min(aiTimeout(env), budget.remaining() - 3000)
        if (timeout <= 0) return
        const parsed = await parseIntent(env.AI, env.AI_MODEL, input.text, event.eventTime, timeout)
        if (!event.inbox.canCommit()) return
        if (parsed.kind === 'timeout' || parsed.kind === 'unavailable') {
          await retryEvent(db, row, event, clock(), 'ai_' + parsed.kind, failedInference)
          return
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
        reply = formatIntentError(action?.type === 'clarify')
        action = undefined
      }
    }

    if (!event.inbox.canCommit()) return
    event.now = clock()
    if (action) reply = await dispatchAction(db, event, action)
    // Mutating actions already commit the Inbox result with their D1 batch.
    if (event.inbox.canCommit() && !await wasProcessed(db, event.eventId)) {
      await finishInboxEvent(db, { ...event, now: clock() }, !!action && action.type !== 'help', reply, failure)
    }
  } catch {
    await retryEvent(db, row, event, clock(), 'd1_error', input.type === 'intent' ? unknownOperation : undefined)
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

async function retryEvent(db: D1Database, row: Claimed, event: InboxEvent, now: number, reason: string, reply?: string) {
  if (!event.inbox.canCommit()) return
  const terminal = row.attempts >= maxAttempts || now - row.received_at >= retention
  console.error('LINE inbox attempt failed', { eventId: row.event_id, attempt: row.attempts, reason })
  if (terminal) {
    await finishInboxEvent(db, { ...event, now }, false, reply, reason)
    return
  }
  await db.prepare(`UPDATE webhook_inbox SET status = 'queued', available_at = ?, last_error = ?, lease_token = NULL, lease_until = NULL
    WHERE receipt_id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`)
    .bind(now + (row.attempts === 1 ? 15_000 : 60_000), reason, row.receipt_id, event.inbox.leaseToken, now).run()
}
