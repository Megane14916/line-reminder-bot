import type { Clarification, TaskAction, TaskDraft } from './intent'
import type { NotificationChange } from './notification-plan'

export type PendingDialogue = {
  question: Clarification | 'title'
  prompt: string
  draft?: TaskDraft
  action?: TaskAction
  quotedAt?: number | null
  originalAt: number
  editText?: string
  observedTask?: { id: number; version: number }
  evidence?: { dates: string[]; times: string[] }
}

export type Dialogue = {
  id: string
  taskId: number | null
  original: string
  pending?: PendingDialogue
  focus?: NotificationChange & { version: number }
}

type Actor = { groupId: string; userId: string; now: number; eventTime: number }
type Row = { id: string; task_id: number | null; original_text: string; pending_json: string | null; focus_json: string | null }

export async function getDialogue(db: D1Database, event: Actor, threadId?: string) {
  const row = await db.prepare(`SELECT id, task_id, original_text, pending_json, focus_json FROM dialogue_threads
    WHERE group_id = ? AND user_id = ? AND expires_at > ? AND updated_at <= ?
      AND ${threadId ? 'id = ?' : 'pending_json IS NOT NULL'} ORDER BY updated_at DESC LIMIT 1`)
    .bind(event.groupId, event.userId, event.now, event.eventTime, ...(threadId ? [threadId] : [])).first<Row>()
  if (!row) return
  return { id: row.id, taskId: row.task_id, original: row.original_text, pending: row.pending_json ? JSON.parse(row.pending_json) : undefined,
    focus: row.focus_json ? JSON.parse(row.focus_json) : undefined } as Dialogue
}

export function saveDialogue(db: D1Database, event: Actor & { eventId: string }, thread: Dialogue) {
  return db.prepare(`INSERT INTO dialogue_threads (id, group_id, user_id, task_id, original_text,
      pending_json, focus_json, updated_at, expires_at)
    SELECT ?, ?, ?, COALESCE(task_id, ?), ?, ?, ?, ?, ? FROM operation_result_outbox WHERE event_id = ? AND thread_id = ?
    ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id,
      pending_json = excluded.pending_json, focus_json = excluded.focus_json, updated_at = excluded.updated_at, expires_at = excluded.expires_at
    WHERE dialogue_threads.group_id = excluded.group_id AND dialogue_threads.user_id = excluded.user_id
      AND dialogue_threads.updated_at <= excluded.updated_at`)
    .bind(thread.id, event.groupId, event.userId, thread.taskId, thread.original,
      thread.pending ? JSON.stringify(thread.pending) : null, thread.focus ? JSON.stringify(thread.focus) : null,
      event.eventTime, event.now + (thread.pending ? 10 : 45) * 60_000, event.eventId, thread.id)
}

export function supersedeDialogues(db: D1Database, event: Actor & { eventId: string }, threadId: string) {
  return db.prepare(`UPDATE dialogue_threads SET pending_json = NULL WHERE group_id = ? AND user_id = ?
    AND pending_json IS NOT NULL AND id <> ? AND updated_at <= ?
    AND EXISTS (SELECT 1 FROM operation_result_outbox WHERE event_id = ? AND thread_id = ?)`)
    .bind(event.groupId, event.userId, threadId, event.eventTime, event.eventId, threadId)
}
