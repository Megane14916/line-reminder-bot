import type { Clarification, TaskAction } from './intent'
import { saveOperationResult, type OperationResult } from '../line/outbox'
import { namesTarget, taskKey } from './target-matching'
import { storeConversation, trimConversation, type ConversationEntry, type Turn } from './conversation'

export type TaskCategory = 'deadline' | 'belonging'
export type Task = {
  id: number; title: string; due_date: string; category: TaskCategory; status: 'open' | 'done'; deleted_at: number | null; completed_at: number | null
  reminder_rule: string; reminder_enabled: number; reminder_anchor: number | null; reminder_version: number; created_at: number
}
export type TaskEvent = {
  groupId: string; userId: string; eventId: string; eventTime: number; now: number
  text?: string
  quoteTaskId?: number | null
  quotedAt?: number | null
  linkTask?: boolean
  observedTask?: { id: number; version: number }
  history?: ConversationEntry[]
  turn?: Partial<Omit<Turn, 'request'>> & { taskId?: number }
  inbox?: { receiptId: number; leaseToken: string; canCommit: () => boolean }
}
export type TaskContext = { task_id: number | null; pending_json: string | null }
export type PendingClarification = { kind: 'clarification'; question: Clarification; text: string; quoteTaskId?: number | null; quotedAt?: number | null }
export type PendingContext = PendingClarification | { kind?: never; action: unknown; ids: number[] }
const taskListLimit = 20

export async function listTasks(db: D1Database, groupId: string, action: Extract<TaskAction, { type: 'list_tasks' }>) {
  const status = action.status ?? 'open'
  const { results } = await db.prepare(`
    SELECT * FROM tasks WHERE group_id = ? AND (? IS NULL OR category = ?)
      AND (? IS NULL OR due_date >= ?) AND (? IS NULL OR due_date <= ?)
      AND ((? = 'deleted' AND deleted_at IS NOT NULL) OR (deleted_at IS NULL AND status = ?))
    ORDER BY due_date, id LIMIT ?
  `).bind(groupId, action.category ?? null, action.category ?? null, action.from ?? null, action.from ?? null,
    action.to ?? null, action.to ?? null, status, status, taskListLimit + 1).all<Task>()
  return { tasks: results.slice(0, taskListLimit), truncated: results.length > taskListLimit }
}

async function searchableTasks(db: D1Database, groupId: string, dueDate: string | undefined, deleted: boolean) {
  const { results } = await db.prepare(`
    SELECT * FROM tasks WHERE group_id = ? AND (deleted_at IS NOT NULL) = ?
      AND (? IS NULL OR due_date = ?) ORDER BY due_date, id LIMIT 201
  `).bind(groupId, Number(deleted), dueDate ?? null, dueDate ?? null).all<Task>()
  return results.length > 200 ? undefined : results
}

export async function findTasks(db: D1Database, groupId: string, name: string, dueDate: string | undefined, deleted: boolean) {
  const tasks = await searchableTasks(db, groupId, dueDate, deleted)
  if (!tasks) return
  const key = taskKey(name)
  const exact = tasks.filter((task) => task.title === name || (key.length >= 2 && taskKey(task.title) === key))
  return (exact.length || key.length < 2 ? exact : tasks.filter((task) => namesTarget(task.title, name))).slice(0, 6)
}

export async function mentionedTask(db: D1Database, groupId: string, text: string) {
  const tasks = await searchableTasks(db, groupId, undefined, false)
  const matches = tasks?.filter((task) => taskKey(task.title).length >= 2 && namesTarget(text, task.title))
  if (matches?.length === 1) return matches[0]
  const alias = /^(?:あの)?([^、。\n]{2,25}?)の(?:やつ|通知)/.exec(text)?.[1]
  if (matches?.length || !alias || /^(?:さっき|前|今|さきほど|例|この|その|あの)/.test(alias)) return
  const candidates = tasks?.filter((task) => namesTarget(task.title, alias))
  if (candidates?.length === 1) return candidates[0]
}

export async function mentionsOtherTask(db: D1Database, groupId: string, text: string, taskId: number, deleted: boolean) {
  const tasks = await searchableTasks(db, groupId, undefined, deleted)
  if (!tasks || tasks.some((task) => task.id !== taskId && taskKey(task.title).length >= 2 && namesTarget(text, task.title))) return true
  const alias = /^(?:あの)?([^、。\n]{2,25}?)のやつ/.exec(text)?.[1]
  return !!alias && !/^(?:さっき|前|今|さきほど|例|この|その|あの)/.test(alias)
    && !tasks.some((task) => task.id === taskId && namesTarget(task.title, alias))
}

export function getTask(db: D1Database, groupId: string, id: number) {
  return db.prepare('SELECT * FROM tasks WHERE group_id = ? AND id = ?').bind(groupId, id).first<Task>()
}

export const sentMessage = `SELECT task_id, NULL AS scheduled_at FROM operation_result_outbox WHERE group_id = ? AND line_message_id = ? AND status = 'sent'
  UNION ALL SELECT task_id, scheduled_at FROM reminder_occurrences WHERE group_id = ? AND line_message_id = ? AND status = 'sent'`

export function getBotMessage(db: D1Database, groupId: string, messageId: string) {
  return db.prepare(sentMessage).bind(groupId, messageId, groupId, messageId).first<{ task_id: number | null; scheduled_at: number | null }>()
}

export function pendingContext(context: TaskContext | null) {
  return context?.pending_json ? JSON.parse(context.pending_json) as PendingContext : null
}

export function getContext(db: D1Database, event: TaskEvent) {
  return db.prepare(`SELECT task_id, pending_json FROM task_contexts
    WHERE group_id = ? AND user_id = ? AND expires_at > ? AND updated_at <= ?`)
    .bind(event.groupId, event.userId, event.now, event.eventTime).first<TaskContext>()
}

export function saveContext(db: D1Database, event: TaskEvent, operation: string, taskId: number | 'new' | null,
  pending: string | null = null, afterChange = false) {
  return db.prepare(`INSERT INTO task_contexts (group_id, user_id, task_id, operation, pending_json, expires_at, updated_at)
    SELECT ?, ?, ${taskId === 'new' ? 'last_insert_rowid()' : '?'}, ?, ?, ?, ? WHERE ${afterChange ? 'changes() = 1' : '1'}
    ON CONFLICT(group_id, user_id) DO UPDATE SET task_id = excluded.task_id, operation = excluded.operation,
      pending_json = excluded.pending_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    WHERE task_contexts.updated_at <= excluded.updated_at`)
    .bind(event.groupId, event.userId, ...(taskId === 'new' ? [] : [taskId]), operation, pending,
      event.now + (pending ? 10 : 45) * 60_000, event.eventTime)
}

export async function applyEvent(db: D1Database, event: TaskEvent, result: OperationResult, ...changes: D1PreparedStatement[]) {
  return commitEvent(db, event, changes, true, result)
}

export function finishInboxEvent(db: D1Database, event: TaskEvent, advance: boolean, result?: string, failure?: string) {
  return commitEvent(db, event, [], advance, result, failure)
}

async function commitEvent(db: D1Database, event: TaskEvent, changes: D1PreparedStatement[], advance: boolean,
  result?: OperationResult, failure?: string) {
  const inbox = event.inbox
  if (inbox && !inbox.canCommit()) return
  const now = event.now
  // The NOT NULL constraint rolls back the batch if this invocation lost its lease.
  const record = inbox ? db.prepare(`INSERT INTO processed_events (event_id, processed_at) VALUES ((
    SELECT event_id FROM webhook_inbox q WHERE receipt_id = ? AND event_id = ? AND status = 'running'
      AND lease_token = ? AND lease_until > ? AND NOT EXISTS (
        SELECT 1 FROM webhook_inbox active WHERE active.group_id = q.group_id AND active.receipt_id <> q.receipt_id
          AND active.status = 'running' AND active.lease_until > ?
      ) ${advance ? `AND NOT EXISTS (
        SELECT 1 FROM webhook_group_progress p WHERE p.group_id = q.group_id AND (p.event_time, p.receipt_id) > (q.event_time, q.receipt_id)
      )` : ''}), ?)`)
    .bind(inbox.receiptId, event.eventId, inbox.leaseToken, now, now, now)
    : db.prepare('INSERT INTO processed_events (event_id, processed_at) VALUES (?, ?)').bind(event.eventId, now)
  const completion: D1PreparedStatement[] = []
  if (inbox) {
    if (result) completion.push(saveOperationResult(db, inbox.receiptId, result, now, failure?.startsWith('ai_') ?? false, !!event.linkTask))
    if (result && event.text && (event.turn || advance)) {
      const { taskId, ...details } = event.turn ?? {}
      completion.push(storeConversation(db, event, { operation: 'answer', ...details, request: event.text.slice(0, 180) }, taskId),
        trimConversation(db, event))
    }
    completion.push(db.prepare(`UPDATE webhook_inbox SET status = ?, finished_at = ?, last_error = ?, input_json = NULL,
      action_json = NULL, reply_token = NULL, lease_token = NULL, lease_until = NULL WHERE receipt_id = ?`)
      .bind(failure ? 'failed' : 'succeeded', now, failure ?? null, inbox.receiptId))
    if (advance) completion.push(db.prepare(`INSERT INTO webhook_group_progress (group_id, event_time, receipt_id) VALUES (?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET event_time = excluded.event_time, receipt_id = excluded.receipt_id
      WHERE (event_time, receipt_id) < (excluded.event_time, excluded.receipt_id)`)
      .bind(event.groupId, event.eventTime, inbox.receiptId))
  }
  try {
    const results = await db.batch([record, ...changes, ...completion])
    return results.slice(1, changes.length + 1)
  } catch (error) {
    if (inbox && !inbox.canCommit()) return
    if (!await wasProcessed(db, event.eventId)) throw error
  }
}

export async function wasProcessed(db: D1Database, eventId: string) {
  const record = await db.prepare('SELECT event_id FROM processed_events WHERE event_id = ?')
    .bind(eventId).first('event_id')
  return record !== null
}
