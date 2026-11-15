import { intentSchema, type TaskAction } from '../tasks/intent'
import { answerSelection, dispatchAction } from '../tasks/actions'
import { askClarification, isClarificationAnswer } from '../tasks/clarification'
import { findTasks, finishInboxEvent, getBotMessage, getContext, getTask, mentionedTask, pendingContext, sentMessage, wasProcessed,
  type TaskEvent } from '../tasks/repository'
import { conversationHistory, notificationFocus } from '../tasks/conversation'
import { literalNotificationEdits, validateNotificationIntent } from '../tasks/notification-dates'
import { reminderSlots, ruleSchema } from '../tasks/schedule'
import { cleanTargetReference, namesTarget } from '../tasks/target-matching'
import { aiTimeout, runtimeBudget, type RuntimeBudget } from '../runtime-budget'
import { parseIntent, quickQuotedIntent } from './intent-parser'
import { formatIntentError, helpMessage } from './messages'
import { drainResults, expiredOperationResults, failedInference, unknownOperation } from './outbox'

export type Input = { type: 'intent' | 'followup'; text: string } |
  { type: 'quote'; messageId: string; text?: string; mentioned?: boolean } | { type: 'selection'; id: number }
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
  let accepted = 0
  for (let i = 0; i < operations.length; i += intakeBatch) {
    const results = await db.batch(operations.slice(i, i + intakeBatch).map((operation) => {
      const { input, groupId, userId, eventTime } = operation
      let guard = ''
      let bindings: (string | number)[] = []
      if (input.type === 'quote' && !input.mentioned) {
        guard = `AND EXISTS (${sentMessage})`
        bindings = [groupId, input.messageId, groupId, input.messageId]
      } else if (input.type === 'followup') {
        guard = `AND EXISTS (SELECT 1 FROM task_contexts WHERE group_id = ? AND user_id = ? AND expires_at > ?
          AND updated_at <= ? AND json_extract(pending_json, '$.kind') = 'clarification')`
        bindings = [groupId, userId, now, eventTime]
      }
      return db.prepare(`INSERT INTO webhook_inbox(event_id, group_id, user_id, event_time, received_at, input_json, reply_token, available_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id = ?) ${guard}
        ON CONFLICT(event_id) DO NOTHING`)
        .bind(operation.eventId, groupId, userId, eventTime, now,
          JSON.stringify(input), operation.replyToken, now, operation.eventId, ...bindings)
    }))
    accepted += results.reduce((count, result) => count + result.meta.changes, 0)
  }
  return accepted
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
    } else if ((input.type === 'intent' || input.type === 'quote' && input.mentioned) && !input.text) {
      reply = helpMessage
    } else {
      const quote = input.type === 'quote' ? await getBotMessage(db, event.groupId, input.messageId) : null
      const text = input.text ?? '完了'
      const context = await getContext(db, event)
      const pending = pendingContext(context)
      let original: string | undefined
      let answeredTask: string | undefined
      if (pending?.kind === 'clarification' && isClarificationAnswer(pending.question, text)
        && (input.type !== 'quote' || (quote && (quote.task_id === pending.quoteTaskId || quote.task_id === context?.task_id)))) {
        if (pending.question !== 'task' || (await findTasks(db, event.groupId, text.trim(), undefined, false))?.length) {
          original = pending.text
          event.quoteTaskId = pending.quoteTaskId
          if (pending.question === 'task') answeredTask = text.trim()
        }
      }
      if (quote && event.quoteTaskId === undefined) event.quoteTaskId = quote.task_id
      event.text = original ? original + '\n補足：' + text : text
      if ((input.type === 'followup' && !original) || (input.type === 'quote' && !quote && !input.mentioned)
        || (quote && /^(?:ありがとう(?:ございます)?|了解(?:です)?|OK)[。！!]*$/i.test(text))) {
        await finishInboxEvent(db, { ...event, now: clock() }, false)
        return
      }
      const contextualId = event.quoteTaskId === undefined ? context?.task_id : event.quoteTaskId
      const [history, named] = await Promise.all([conversationHistory(db, event),
        quote ? Promise.resolve(undefined) : mentionedTask(db, event.groupId, event.text)])
      event.history = history
      const contextualTask = named ?? (contextualId ? await getTask(db, event.groupId, contextualId) : null)
      if (contextualTask) event.observedTask = { id: contextualTask.id, version: contextualTask.reminder_version }
      const quick = quote?.task_id && !original ? quickQuotedIntent(text) : undefined
      const literal = contextualTask && !original ? literalNotificationEdits(text, event.eventTime) : undefined
      if (quick && quote?.task_id) {
        action = { ...quick, target: { by: 'id', id: quote.task_id } }
      } else if (row.action_json) {
        const saved = JSON.parse(row.action_json)
        if (saved.action) event.observedTask = saved.observedTask
        action = intentSchema.parse(saved.action ?? saved)
      } else if (literal && contextualTask) {
        action = intentSchema.parse({ type: 'edit_notifications',
          target: { by: 'id', id: contextualTask.id }, edits: literal })
      } else {
        const rule = contextualTask ? ruleSchema.parse(JSON.parse(contextualTask.reminder_rule)) : undefined
        const timeout = Math.min(aiTimeout(env), budget.remaining() - 3000)
        if (timeout <= 0) return
        const parsed = await parseIntent(env.AI, env.AI_MODEL, event.text, event.eventTime, timeout, {
          quoted: !!quote, question: original && pending?.kind === 'clarification' ? pending.question : undefined,
          recentConversation: history.length ? history : undefined,
          task: contextualTask && rule ? { id: contextualTask.id, title: contextualTask.title, dueDate: contextualTask.due_date,
            status: contextualTask.deleted_at !== null ? 'deleted' : contextualTask.status, reminderEnabled: !!contextualTask.reminder_enabled,
            rule, version: contextualTask.reminder_version,
            upcoming: contextualTask.reminder_enabled && contextualTask.status === 'open' && contextualTask.deleted_at === null
              ? reminderSlots(rule, contextualTask.due_date, contextualTask.reminder_anchor ?? contextualTask.created_at, clock(), 4)
                .map((at) => new Date(at).toISOString()) : [],
            focus: notificationFocus(history, contextualTask.id, contextualTask.reminder_version) } : undefined,
        })
        if (!event.inbox.canCommit()) return
        if (parsed.kind === 'timeout' || parsed.kind === 'unavailable') {
          await retryEvent(db, row, event, clock(), 'ai_' + parsed.kind, failedInference)
          return
        }
        if (parsed.kind === 'parsed') {
          const proposal = parsed.action
          action = authorizeIntent(answeredTask && 'target' in proposal
            ? { ...proposal, target: { by: 'name', name: answeredTask } } : proposal, event.text, !!quote || original !== undefined, event.eventTime)
          if (action) {
            const saved = await db.prepare(`UPDATE webhook_inbox SET action_json = ? WHERE receipt_id = ?
              AND status = 'running' AND lease_token = ? AND lease_until > ?`)
            .bind(JSON.stringify({ action, observedTask: event.observedTask }), row.receipt_id, event.inbox.leaseToken, clock()).run()
            if (!saved.meta.changes) return
          }
        }
      }
      if (action?.type === 'clarify' && action.question) {
        event.now = clock()
        reply = await askClarification(db, event, action.question, event.quoteTaskId ?? undefined)
        action = undefined
      } else if (!action || action.type === 'unknown' || action.type === 'clarify') {
        failure = 'invalid_intent'
        reply = formatIntentError()
        action = undefined
      }
    }

    if (!event.inbox.canCommit()) return
    event.now = clock()
    if (action) {
      event.turn = { operation: action.type }
      reply = await dispatchAction(db, event, action)
    }
    // Mutating actions already commit the Inbox result with their D1 batch.
    if (event.inbox.canCommit() && !await wasProcessed(db, event.eventId)) {
      await finishInboxEvent(db, { ...event, now: clock() }, !!action && action.type !== 'help', reply, failure)
    }
  } catch {
    await retryEvent(db, row, event, clock(), 'd1_error', input.type !== 'selection' ? unknownOperation : undefined)
  }
}

export function authorizeIntent(action: TaskAction, text: string, contextual = false, now?: number): TaskAction | undefined {
  if ('target' in action) {
    if (action.target.by === 'id' && !text.normalize('NFKC').match(/#[0-9]+/g)?.includes('#' + action.target.id)) return
    if (action.target.by === 'name') {
      const name = cleanTargetReference(action.target.name)
      if (!namesTarget(text, name)) return
      action = { ...action, target: { ...action.target, name } }
    }
    if (action.target.by === 'recent' && !contextual && action.type !== 'edit_notifications' && !action.type.includes('reminder') &&
      !/さっき|やっぱ|これ|それ|この|その|前の|今の/.test(text)) return
  }
  const normalized = text.normalize('NFKC')
  const edit = action.type === 'modify_reminder' || action.type === 'set_reminder' || action.type === 'edit_notifications'
  if (edit && /早め|遅め|もっと早|もっと遅/.test(normalized) && !/\d+(?:時|:\d{2}|日|週間)|前日|当日|朝|夜/.test(normalized)) {
    return { type: 'clarify', question: 'time' }
  }
  const additive = /(?:日前|週間前|前日|当日|時(?:\d+分)?|:\d{2})(?:に)?も(?:\s|[、。！!]|通知|教え|知らせ|追加|欲しい|ほしい|$)/.test(normalized)
  const replacement = action.type === 'modify_reminder' ? action.edit.mode === 'replace' : action.type === 'set_reminder' && action.setting.by === 'rule'
  const isAddition = action.type === 'modify_reminder' && (action.edit.mode === 'add' || action.edit.mode === 'add_time') ||
    action.type === 'edit_notifications' && action.edits.some((edit) => edit.op === 'add' || edit.op === 'add_clock') &&
      (action.edits.every((edit) => edit.op === 'add' || edit.op === 'add_clock') ||
        /消して|削除|じゃなく|ではなく|いらない|止めて|停止|再開|変更|に変え|を[^、。]+にして/.test(normalized))
  if (additive && !isAddition && (('target' in action && action.type !== 'get_reminder') || action.type === 'set_group_default') &&
    !/\n補足：(?:置き換え|入れ替え)/.test(text)) return { type: 'clarify', question: 'mode' }
  if (replacement && action.type === 'modify_reminder' &&
    !/だけ|のみ|代わり|置き換|入れ替|リセット|全部|これから|今後|にし[てたい]|に変え|に変更|でいい|じゃなく/.test(normalized)) {
    return { type: 'clarify', question: 'mode' }
  }
  return now === undefined ? action : validateNotificationIntent(action, text, now)
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
