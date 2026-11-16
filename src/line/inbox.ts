import { intentSchema, type TaskAction } from '../tasks/intent'
import { answerSelection, dispatchAction } from '../tasks/actions'
import { askClarification, followupQuestions, holdDialogue } from '../tasks/clarification'
import { applyEvent, findTasks, finishInboxEvent, getBotMessage, getContext, getTask, mentionedTask, pendingContext, saveContext, sentMessage, wasProcessed,
  type TaskEvent } from '../tasks/repository'
import { conversationHistory, notificationFocus } from '../tasks/conversation'
import { getDialogue, type Dialogue } from '../tasks/dialogue'
import { continuationFields, dateTimeEvidence, groundedTitle, groundTemporalDraft, hasDifferentQuotedSubject, reconcileDraft,
  resolveDraft, validateCreation } from '../tasks/draft'
import { withoutVagueClock } from '../tasks/draft-edits'
import { explicitNotificationDates, explicitNotificationTimes, literalNotificationEdits, notificationDateQuery, validateNotificationIntent } from '../tasks/notification-dates'
import { reminderSlots, ruleSchema } from '../tasks/schedule'
import { cleanTargetReference, namesTarget } from '../tasks/target-matching'
import { aiTimeout, runtimeBudget, type RuntimeBudget } from '../runtime-budget'
import { parseIntent, quickQuotedIntent } from './intent-parser'
import { formatIntentError, helpMessage } from './messages'
import { drainResults, expiredOperationResults, failedInference, unknownOperation } from './outbox'

export type Input = ({ type: 'intent' | 'followup'; text: string } |
  { type: 'quote'; messageId: string; text?: string; mentioned?: boolean } | { type: 'selection'; id: number }) & { sourceMessageId?: string }
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
        guard = `AND EXISTS (SELECT 1 FROM (${sentMessage}) msg WHERE msg.thread_question = 0 OR EXISTS (
          SELECT 1 FROM dialogue_threads d WHERE d.id = msg.thread_id AND d.group_id = ? AND d.user_id = ?
            AND d.pending_json IS NOT NULL AND d.expires_at > ? AND d.updated_at <= ?))`
        bindings = [groupId, input.messageId, groupId, input.messageId, groupId, userId, now, eventTime]
      } else if (input.type === 'followup') {
        const questions = JSON.stringify(followupQuestions(input.text, eventTime))
        const matchingTaskAnswer = `(json_extract(pending_json, '$.question') = 'task' AND EXISTS (
          SELECT 1 FROM tasks WHERE group_id = ? AND title = ? AND deleted_at IS NULL))`
        guard = `AND (EXISTS (SELECT 1 FROM dialogue_threads WHERE group_id = ? AND user_id = ? AND expires_at > ?
          AND updated_at <= ? AND pending_json IS NOT NULL AND (json_extract(pending_json, '$.question') IN (SELECT value FROM json_each(?))
          OR ${matchingTaskAnswer}))
          OR EXISTS (SELECT 1 FROM task_contexts WHERE group_id = ? AND user_id = ? AND expires_at > ?
          AND updated_at <= ? AND json_extract(pending_json, '$.kind') = 'clarification'
          AND (json_extract(pending_json, '$.question') IN (SELECT value FROM json_each(?)) OR ${matchingTaskAnswer})))`
        const scope = [groupId, userId, now, eventTime, questions, groupId, input.text.trim()]
        bindings = [...scope, ...scope]
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
  event.messageId = input.sourceMessageId
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
      const [context, stored] = await Promise.all([getContext(db, event),
        quote ? quote.thread_id ? getDialogue(db, event, quote.thread_id) : undefined : getDialogue(db, event)])
      const old = pendingContext(context)
      const legacy = !stored && !quote && old?.kind === 'clarification' ? old : undefined
      const pending = stored?.pending ?? (legacy ? {
        question: legacy.question, prompt: formatIntentError(legacy.question), originalAt: event.eventTime, quotedAt: legacy.quotedAt,
      } : undefined)
      const original = pending ? stored?.original ?? legacy?.text : undefined
      if ((input.type === 'followup' && !pending) || (input.type === 'quote' && !quote && !input.mentioned)
        || (quote?.thread_question && !stored?.pending)
        || (quote && /^(?:ありがとう(?:ございます)?|了解(?:です)?|OK)[。！!]*$/i.test(text))) {
        await finishInboxEvent(db, { ...event, now: clock() }, false)
        return
      }
      const newThread: Dialogue = { id: event.eventId, original: legacy?.text ?? text, taskId: quote ? quote.task_id : null }
      event.thread = stored ?? newThread
      event.startsThread = !stored
      const startRegistrationThread = () => {
        event.thread = { id: event.eventId, original: text, taskId: null }
        event.startsThread = true
        event.quoteTaskId = undefined
        event.quotedAt = undefined
        event.observedTask = undefined
      }
      event.text = text
      event.quoteTaskId = quote?.task_id ?? legacy?.quoteTaskId
      if (quote && quote.task_id === null && !stored?.taskId) event.quoteTaskId = null
      event.quotedAt = quote?.scheduled_at ?? pending?.quotedAt ?? (quote ? null : undefined)
      const contextualId = event.quoteTaskId === undefined ? stored?.taskId ?? context?.task_id : event.quoteTaskId
      const [history, named] = await Promise.all([conversationHistory(db, event),
        quote || stored?.pending ? undefined : mentionedTask(db, event.groupId, text)])
      event.history = history
      const contextualTask = named ?? (contextualId ? await getTask(db, event.groupId, contextualId) : null)
      if (contextualTask) event.observedTask = { id: contextualTask.id, version: contextualTask.reminder_version }
      const dialogueVersion = pending?.observedTask
      const quick = quote?.task_id && !pending ? quickQuotedIntent(text) : undefined
      const focus = contextualTask && (stored?.taskId === contextualTask.id && stored.focus?.version === contextualTask.reminder_version
        ? stored.focus : notificationFocus(history, contextualTask.id, contextualTask.reminder_version))
      const correctRecentNotice = Boolean(focus && !focus.before && focus.after &&
        /^(?:やっぱり?|いや[、,]?)\s*(?:朝|夜|午前|午後)?\s*\d{1,2}(?::\d{2}|時(?:半|\d{1,2}分)?)(?:で(?:いい)?|にして)?[。！!]*$/.test(text.normalize('NFKC')))
      if (quick && quote?.task_id) {
        action = { ...quick, target: { by: 'id', id: quote.task_id } }
      } else if (row.action_json) {
        const saved = JSON.parse(row.action_json)
        if (saved.action) {
          event.observedTask = saved.observedTask
          event.thread = saved.thread ?? event.thread
          event.startsThread = saved.startsThread ?? event.startsThread
          event.text = saved.text ?? event.text
          if (saved.reference) {
            event.quoteTaskId = saved.reference.taskId
            event.quotedAt = saved.reference.at
          }
          event.pendingPlan = saved.pendingPlan
        }
        action = intentSchema.parse(saved.action ?? saved)
      } else if (!pending && notificationDateQuery(text, event.eventTime, false)) {
        action = { type: 'get_reminder', target: contextualTask ? { by: 'id', id: contextualTask.id } : { by: 'recent' } }
      } else {
        const rule = contextualTask ? ruleSchema.parse(JSON.parse(contextualTask.reminder_rule)) : undefined
        const timeout = Math.min(aiTimeout(env), budget.remaining() - 3000)
        if (timeout <= 0) return
        const parsed = await parseIntent(env.AI, env.AI_MODEL, event.text, event.eventTime, timeout, {
          quoted: !!quote, question: pending?.question, pending, original: stored?.original ?? original,
          followup: input.type === 'followup' || Boolean(quote?.thread_question),
          recentConversation: history.length ? history : undefined,
          task: contextualTask && rule ? { id: contextualTask.id, title: contextualTask.title, dueDate: contextualTask.due_date,
            status: contextualTask.deleted_at !== null ? 'deleted' : contextualTask.status, reminderEnabled: !!contextualTask.reminder_enabled,
            rule, version: contextualTask.reminder_version,
            upcoming: contextualTask.reminder_enabled && contextualTask.status === 'open' && contextualTask.deleted_at === null
              ? reminderSlots(rule, contextualTask.due_date, contextualTask.reminder_anchor ?? contextualTask.created_at, clock(), 4)
                .map((at) => new Date(at).toISOString()) : [],
            focus: focus || undefined } : undefined,
        })
        if (!event.inbox.canCommit()) return
        if (parsed.kind === 'timeout' || parsed.kind === 'unavailable') {
          await retryEvent(db, row, event, clock(), 'ai_' + parsed.kind, failedInference)
          return
        }
        const dialogue = parsed.kind === 'dialogue' ? parsed.proposal : parsed.kind === 'parsed'
          ? groundTemporalDraft(parsed.action, text, event.eventTime, pending) : undefined
        const registrationTitle = dialogue?.type === 'draft' && dialogue.operation === 'create_task' ? dialogue.fields.title
          : parsed.kind === 'parsed' && parsed.action.type === 'create_task' ? parsed.action.title : undefined
        const newRegistration = registrationTitle && (registrationTitle !== pending?.draft?.fields.title) &&
          input.type !== 'followup' && groundedTitle(text, registrationTitle) &&
          !(pending?.draft?.operation === 'create_task' && /(?:名前|名称|タイトル)(?:を|は)/.test(text))
        const resumeDraft = pending?.draft && !newRegistration ? { ...pending, draft: pending.draft } : undefined
        if (!registrationTitle && contextualTask && quote?.task_id === contextualTask.id &&
          hasDifferentQuotedSubject(text, contextualTask.title, event.eventTime) &&
          (dialogue?.type === 'draft' || parsed.kind === 'parsed' && 'target' in parsed.action)) {
          await finishInboxEvent(db, { ...event, thread: undefined, now: clock() }, false, '💬 新しいタスクの登録ですか？ 引用したタスクの変更ですか？')
          return
        }
        const repeatQuestion = async () => {
          event.now = clock()
          const validity = dateTimeEvidence(text, event.eventTime)
          const prompt = validity.invalidTime ? '🔔 時刻を確認して、もう一度教えてください。'
            : validity.invalidDay ? '📅 日付を確認して、もう一度教えてください。' : pending?.prompt
          if (pending) await holdDialogue(db, event, { ...pending, prompt: prompt ?? pending.prompt })
          else await finishInboxEvent(db, event, false, formatIntentError(), 'invalid_intent')
        }
        if (dialogue) {
          const proposal = dialogue
          if (proposal.type === 'ignore') {
            if (resumeDraft && (input.type === 'followup' || quote?.thread_question)) await repeatQuestion()
            else await finishInboxEvent(db, { ...event, now: clock() }, false)
            return
          }
          if (proposal.type === 'cancel' && pending) {
            event.thread.pending = undefined
            const message = '進行中の依頼を取り消しました。'
            await applyEvent(db, { ...event, now: clock() }, message, saveContext(db, event, 'cancel', stored?.taskId ?? context?.task_id ?? null))
            return
          }
        }
        if (resumeDraft || dialogue?.type === 'draft') {
          const update = dialogue?.type === 'continue' || dialogue?.type === 'draft' && dialogue.operation === resumeDraft?.draft.operation
            ? dialogue : !dialogue && parsed.kind === 'parsed' && resumeDraft ? continuationFields(parsed.action, resumeDraft.draft) : undefined
          let resumed = resumeDraft && update ? reconcileDraft(resumeDraft, update, original ?? text, text, event.eventTime) : undefined
          if (!resumed && resumeDraft?.draft.operation === 'edit_notifications' &&
            (parsed.kind === 'invalid' || parsed.kind === 'parsed' && parsed.action.type === 'edit_notifications')) {
            resumed = reconcileDraft(resumeDraft, { fields: {} }, original ?? text, text, event.eventTime, true)
          }
          if (resumeDraft && !resumed || !resumeDraft && dialogue?.type !== 'draft') {
            await repeatQuestion()
            return
          }
          const draft = resumed?.draft ?? (dialogue?.type === 'draft' ? dialogue : undefined)
          if (!draft) {
            await repeatQuestion()
            return
          }
          if (!resumed && draft.operation === 'create_task') startRegistrationThread()
          const target = draft.fields.target
          if (!resumed && draft.operation === 'edit_notifications' && target?.by === 'name' && namesTarget(text, target.name)) {
            const matches = await findTasks(db, event.groupId, target.name, target.dueDate, false)
            const namedTask = matches?.length === 1 ? matches[0] : undefined
            if (namedTask && (!quote?.task_id || quote.task_id === namedTask.id)) {
              event.thread.taskId = namedTask.id
              event.observedTask = { id: namedTask.id, version: namedTask.reminder_version }
            }
          }
          if (resumed?.pending.observedTask) event.observedTask = resumed.pending.observedTask
          const draftOrigin = resumed ? original ?? text : text
          const originalAt = resumed?.pending.originalAt ?? event.eventTime
          const draftResult = resolveDraft(draft, draftOrigin, originalAt, text, event.eventTime, resumed?.pending)
          if ('pending' in draftResult) {
            event.now = clock()
            const taskId = draft.operation === 'edit_notifications' ? event.thread.taskId ?? contextualTask?.id : undefined
            await holdDialogue(db, event, { ...draftResult.pending, quotedAt: event.quotedAt,
              observedTask: draft.operation === 'edit_notifications' ? event.observedTask : undefined }, taskId)
            return
          }
          if (draftResult.action.type === 'create_task') action = draftResult.action
          else {
            const expected = draftResult.action
            event.text = withoutVagueClock(resumed?.pending.editText ?? draftOrigin)
            action = authorizeIntent(expected, event.text, !!contextualTask, event.eventTime)
            if (action?.type !== 'edit_notifications' || expected.type !== 'edit_notifications' ||
              action.edits.length !== expected.edits.length ||
              action.edits.some((edit, index) => edit.op !== expected.edits[index].op)) {
              await repeatQuestion()
              return
            }
            event.pendingPlan = { ...(resumed?.pending ?? { question: 'day', prompt: '🔔 どの通知を変更しますか？', originalAt }),
              draft, quotedAt: event.quotedAt, observedTask: event.observedTask }
          }
        } else if (!dialogue && parsed.kind === 'parsed') {
          let proposal = parsed.action
          if ((input.type === 'followup' || quote?.thread_question) && pending && proposal.type !== 'clarify' && proposal.type !== 'unknown') {
            const reminder = (operation: string) => ['edit_notifications', 'modify_reminder', 'set_reminder'].includes(operation)
            const previous = pending.action?.type
            const matches = previous ? proposal.type === previous || reminder(proposal.type) && reminder(previous)
              : pending.question === 'task' ? 'target' in proposal : reminder(proposal.type)
            if (!matches) {
              await repeatQuestion()
              return
            }
          }
          const continuing = !!pending && (input.type === 'followup' || !!quote?.thread_question)
          if (continuing && pending.question === 'task' && 'target' in proposal) {
            const candidates = await findTasks(db, event.groupId, text.trim(), undefined, proposal.type === 'restore_task')
            if (candidates?.some(({ title }) => title === text.trim())) proposal = { ...proposal, target: { by: 'name', name: text.trim() } }
          }
          if (pending && !continuing && proposal.type !== 'clarify' && proposal.type !== 'unknown') {
            event.thread = newThread
            event.startsThread = true
          }
          if (proposal.type === 'create_task' && (!pending || newRegistration)) startRegistrationThread()
          if (continuing && original) event.text = original + '\n補足：' + text
          if (proposal.type !== 'clarify' && proposal.type !== 'unknown') event.interpretedAction = proposal
          action = authorizeIntent(proposal, event.text, !!contextualTask || !!quote || continuing, event.eventTime, correctRecentNotice)
        }
        if ((!action || action.type === 'clarify' || action.type === 'unknown') && !pending && !correctRecentNotice &&
          (parsed.kind === 'parsed' && 'target' in parsed.action && parsed.action.type.includes('reminder') ||
            parsed.kind === 'parsed' && parsed.action.type === 'edit_notifications' || parsed.kind === 'invalid')) {
          const edits = literalNotificationEdits(text, event.eventTime)
          const target = action?.type !== 'unknown' && parsed.kind === 'parsed' && 'target' in parsed.action &&
            parsed.action.target.by === 'name' && namesTarget(text, parsed.action.target.name) ? parsed.action.target
            : { by: 'recent' } as const
          if (edits) action = { type: 'edit_notifications', target, edits }
        }
        if (action) {
          if (action.type === 'edit_notifications' && dialogueVersion && !event.startsThread) event.observedTask = dialogueVersion
          if (action.type !== 'clarify' && action.type !== 'unknown') event.thread.pending = undefined
          const saved = await db.prepare(`UPDATE webhook_inbox SET action_json = ? WHERE receipt_id = ?
              AND status = 'running' AND lease_token = ? AND lease_until > ?`)
            .bind(JSON.stringify({ action, observedTask: event.observedTask, thread: event.thread, startsThread: event.startsThread,
              text: event.text, pendingPlan: event.pendingPlan, reference: { taskId: event.quoteTaskId, at: event.quotedAt } }),
              row.receipt_id, event.inbox.leaseToken, clock()).run()
          if (!saved.meta.changes) return
        }
      }
      if (action?.type === 'clarify' && action.question) {
        event.now = clock()
        reply = await askClarification(db, event, action.question, event.quoteTaskId ?? contextualTask?.id ?? undefined)
        action = undefined
      } else if (!action || action.type === 'unknown' || action.type === 'clarify') {
        if (input.type === 'followup') {
          await finishInboxEvent(db, { ...event, now: clock() }, false)
          return
        }
        failure = 'invalid_intent'
        reply = formatIntentError()
        action = undefined
      }
    }

    if (!event.inbox.canCommit()) return
    event.now = clock()
    if (action) {
      event.turn = { operation: action.type }
      event.interpretedAction = action
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

export function authorizeIntent(action: TaskAction, text: string, contextual = false, now?: number, correctRecentNotice = false): TaskAction | undefined {
  if ('target' in action) {
    if (action.target.by === 'id' && !text.normalize('NFKC').match(/#[0-9]+/g)?.includes('#' + action.target.id)) return
    if (action.target.by === 'name') {
      const name = cleanTargetReference(action.target.name)
      if (!contextual && !namesTarget(text, name)) return { type: 'clarify', question: 'task' }
      action = { ...action, target: { ...action.target, name } }
    }
    if (action.target.by === 'recent' && !contextual && action.type !== 'edit_notifications' && !action.type.includes('reminder') &&
      !/さっき|やっぱ|これ|それ|この|その|前の|今の/.test(text)) return
  }
  if (action.type === 'create_task' && now !== undefined) return validateCreation(action, text, now)
  if (action.type === 'update_task' && action.dueDate && now !== undefined) {
    const dueDate = action.dueDate
    const dates = explicitNotificationDates(text, now)
    if (dates.some(({ date }) => !date) || dates.length && !dates.some(({ date }) => date === dueDate)) {
      return { type: 'clarify', question: 'day' }
    }
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
  if (correctRecentNotice && action.type === 'edit_notifications') {
    const spoken = explicitNotificationTimes(text)
    const [edit] = action.edits
    if (action.edits.length !== 1 || spoken.length !== 1 || !spoken[0]) return { type: 'clarify', question: 'day' }
    if (edit.op === 'set_clock' && edit.time === spoken[0]) {
      action = { ...action, edits: [{ op: 'move', selector: { kind: 'recent' }, to: { kind: 'time', time: edit.time } }] }
    } else if (edit.op !== 'move' || edit.selector.kind !== 'recent' || edit.to.kind !== 'time' || edit.to.time !== spoken[0]) {
      return { type: 'clarify', question: 'day' }
    }
  }
  return now === undefined ? action : validateNotificationIntent(action, text, now, correctRecentNotice)
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
