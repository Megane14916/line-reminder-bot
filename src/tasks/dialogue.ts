import type { Clarification, TaskAction, TaskDraft } from './intent'
import type { NotificationChange } from './notification-plan'

export type PendingDialogue = {
  question: Clarification | 'title'
  prompt: string
  draft?: TaskDraft
  action?: TaskAction
  quotedAt?: number | null
  originalAt: number
  original?: string
  editText?: string
  observedTask?: { id: number; version: number }
  evidence?: { dates: string[]; times: string[] }
}
export type Dialogue = {
  id: string
  taskId: number | null
  original: string
  pending?: PendingDialogue
  selection?: { action: object; ids: number[] }
  focus?: NotificationChange & { version: number }
}

type Actor = { groupId: string; userId: string; now: number; eventTime: number }
type Row = { id: string; task_id: number | null; original_text: string; pending_json: string | null; focus_json: string | null;
  selection_json: string | null }

export async function getDialogue(db: D1Database, event: Actor, threadId?: string) {
  const { results } = await db.prepare(`SELECT id, task_id, original_text, pending_json, focus_json, selection_json FROM dialogue_threads
    WHERE group_id = ? AND user_id = ? AND expires_at > ? AND updated_at <= ?
      AND ${threadId ? 'id = ?' : '(pending_json IS NOT NULL OR selection_json IS NOT NULL)'} LIMIT 2`)
    .bind(event.groupId, event.userId, event.now, event.eventTime, ...(threadId ? [threadId] : [])).all<Row>()
  if (results.length > 1) return null
  const [row] = results
  if (!row) return
  return { id: row.id, taskId: row.task_id, original: row.original_text, pending: row.pending_json ? JSON.parse(row.pending_json) : undefined,
    selection: row.selection_json ? JSON.parse(row.selection_json) : undefined,
    focus: row.focus_json ? JSON.parse(row.focus_json) : undefined } as Dialogue
}

export function saveDialogue(db: D1Database, event: Actor & { eventId: string }, thread: Dialogue, requiresTaskChange: boolean) {
  return db.prepare(`WITH result AS (
      SELECT task_id, (? = 0 OR task_id IS NOT NULL) AS applied FROM operation_result_outbox WHERE event_id = ? AND thread_id = ?
    ) INSERT INTO dialogue_threads (id, group_id, user_id, task_id, original_text,
      pending_json, focus_json, selection_json, updated_at, expires_at)
    SELECT ?, ?, ?, CASE WHEN applied THEN COALESCE(task_id, ?) END, ?,
      CASE WHEN applied THEN ? END, CASE WHEN applied THEN ? END, CASE WHEN applied THEN ? END, ?,
      CASE WHEN applied THEN ? ELSE ? END FROM result WHERE 1
    ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id,
      pending_json = excluded.pending_json, focus_json = excluded.focus_json, selection_json = excluded.selection_json,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at
    WHERE dialogue_threads.group_id = excluded.group_id AND dialogue_threads.user_id = excluded.user_id
      AND dialogue_threads.updated_at <= excluded.updated_at AND (SELECT applied FROM result)`)
    .bind(Number(requiresTaskChange), event.eventId, thread.id, thread.id, event.groupId, event.userId, thread.taskId, thread.original,
      thread.pending ? JSON.stringify(thread.pending) : null, thread.focus ? JSON.stringify(thread.focus) : null,
      thread.selection ? JSON.stringify(thread.selection) : null,
      event.eventTime, event.now + (thread.pending || thread.selection ? 10 : 45) * 60_000, event.now + 45 * 60_000)
}
