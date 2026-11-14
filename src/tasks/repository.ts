import type { TaskAction } from './intent'

export type TaskCategory = 'deadline' | 'belonging'
export type Task = {
  id: number; title: string; due_date: string; category: TaskCategory; status: 'open' | 'done'; deleted_at: number | null; completed_at: number | null
  reminder_rule: string; reminder_enabled: number; reminder_anchor: number | null; reminder_version: number; created_at: number
}
export type TaskEvent = { groupId: string; userId: string; eventId: string; eventTime: number; now: number }
export type TaskContext = { task_id: number | null; pending_json: string | null }
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

export async function findTasks(db: D1Database, groupId: string, name: string, dueDate: string | undefined, deleted: boolean) {
  const { results } = await db.prepare(`
    SELECT * FROM tasks WHERE group_id = ? AND (deleted_at IS NOT NULL) = ? AND instr(title, ?) > 0
      AND (? IS NULL OR due_date = ?) ORDER BY due_date, id LIMIT 6
  `).bind(groupId, Number(deleted), name, dueDate ?? null, dueDate ?? null).all<Task>()
  return results
}

export function getTask(db: D1Database, groupId: string, id: number) {
  return db.prepare('SELECT * FROM tasks WHERE group_id = ? AND id = ?').bind(groupId, id).first<Task>()
}

export function getQuotedTask(db: D1Database, groupId: string, messageId: string) {
  return db.prepare(`SELECT task_id FROM reminder_occurrences WHERE group_id = ? AND line_message_id = ? AND status = 'sent'`)
    .bind(groupId, messageId).first<number>('task_id')
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
      event.now + 10 * 60_000, event.eventTime)
}

export async function applyEvent(db: D1Database, event: TaskEvent, ...changes: D1PreparedStatement[]) {
  const record = db.prepare('INSERT INTO processed_events (event_id, processed_at) VALUES (?, ?)')
    .bind(event.eventId, event.now)
  try {
    const [, ...results] = await db.batch([record, ...changes])
    return results
  } catch (error) {
    if (!await wasProcessed(db, event.eventId)) throw error
  }
}

export async function wasProcessed(db: D1Database, eventId: string) {
  const record = await db.prepare('SELECT event_id FROM processed_events WHERE event_id = ?')
    .bind(eventId).first('event_id')
  return record !== null
}
