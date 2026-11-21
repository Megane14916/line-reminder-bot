import type { NotificationChange } from './notification-plan'
import type { ReminderRule } from './schedule'

export type Turn = {
  request: string
  operation: string
  question?: string
  version?: number
  before?: ReminderRule
  after?: ReminderRule
  changes?: NotificationChange[]
}
export type ConversationEntry = Turn & { taskId: number | null; eventTime: number; reply?: string }
type Actor = { groupId: string; userId: string; eventTime: number; now: number }

export async function conversationHistory(db: D1Database, event: Actor, threadId: string): Promise<ConversationEntry[]> {
  const { results } = await db.prepare(`SELECT c.task_id, c.turn_json, c.event_time,
      CASE WHEN o.status = 'sent' THEN c.reply_text END AS reply
    FROM task_conversation c JOIN dialogue_threads d ON d.id = c.thread_id
    LEFT JOIN operation_result_outbox o ON o.event_id = c.event_id
    WHERE c.thread_id = ? AND d.group_id = ? AND d.user_id = ? AND c.event_time <= ? AND d.expires_at > ?
    ORDER BY c.event_time, c.rowid`).bind(threadId, event.groupId, event.userId, event.eventTime, event.now)
    .all<{ task_id: number | null; turn_json: string; event_time: number; reply: string | null }>()
  return results.map((row) => ({ ...JSON.parse(row.turn_json) as Turn, taskId: row.task_id,
    eventTime: row.event_time, reply: row.reply ?? undefined }))
}

export function notificationFocus(history: ConversationEntry[], taskId: number, version: number) {
  const latest = history.findLast((entry) => entry.taskId === taskId && entry.changes?.length)
  if (latest?.version !== version || latest.changes?.length !== 1) return
  return latest.changes[0]
}

export function storeConversation(db: D1Database, event: Actor & { eventId: string }, threadId: string, turn: Turn, checkTaskId?: number) {
  return db.prepare(`INSERT INTO task_conversation (event_id, group_id, user_id, task_id, event_time, expires_at, turn_json, thread_id, reply_text)
    SELECT ?, d.group_id, d.user_id, o.task_id, ?, d.expires_at, CASE WHEN ? IS NULL OR o.task_id = ? THEN ? ELSE ? END, d.id, o.text
    FROM dialogue_threads d LEFT JOIN operation_result_outbox o ON o.event_id = ?
    WHERE d.id = ? AND d.group_id = ? AND d.user_id = ?
      AND (o.event_id IS NULL OR o.thread_id = ?)`)
    .bind(event.eventId, event.eventTime, checkTaskId ?? null, checkTaskId ?? null, JSON.stringify(turn),
      JSON.stringify({ operation: 'answer', request: turn.request }), event.eventId, threadId, event.groupId, event.userId, threadId)
}

export function expireConversation(db: D1Database, now: number) {
  return db.batch([
    db.prepare(`DELETE FROM task_conversation WHERE event_id IN (
      SELECT event_id FROM task_conversation WHERE thread_id IS NULL AND expires_at <= ? ORDER BY expires_at LIMIT 100)`).bind(now),
    db.prepare(`DELETE FROM task_contexts WHERE rowid IN (
      SELECT rowid FROM task_contexts WHERE expires_at <= ? LIMIT 100)`).bind(now),
    db.prepare(`DELETE FROM dialogue_threads WHERE id IN (
      SELECT id FROM dialogue_threads WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`).bind(now),
  ])
}
