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
export type ConversationEntry = Turn & { taskId: number | null }
type Actor = { groupId: string; userId: string; eventTime: number; now: number }
const minutes = 45
const limit = 5

export async function conversationHistory(db: D1Database, event: Actor): Promise<ConversationEntry[]> {
  const { results } = await db.prepare(`SELECT task_id, turn_json FROM task_conversation
    WHERE group_id = ? AND user_id = ? AND event_time <= ? AND expires_at > ?
    ORDER BY event_time DESC, rowid DESC LIMIT ?`).bind(event.groupId, event.userId, event.eventTime, event.now, limit)
    .all<{ task_id: number | null; turn_json: string }>()
  return results.map((row) => ({ ...JSON.parse(row.turn_json) as Turn, taskId: row.task_id }))
}

export function notificationFocus(history: ConversationEntry[], taskId: number, version: number) {
  const latest = history.find((entry) => entry.taskId === taskId && entry.changes?.length)
  if (latest?.version !== version || latest.changes?.length !== 1) return
  return latest.changes[0]
}

export function storeConversation(db: D1Database, event: Actor & { eventId: string }, turn: Turn, checkTaskId?: number) {
  return db.prepare(`INSERT INTO task_conversation (event_id, group_id, user_id, task_id, event_time, expires_at, turn_json)
    SELECT ?, ?, ?, task_id, ?, ?, ? FROM operation_result_outbox WHERE event_id = ?
      AND (? IS NULL OR task_id = ?)`)
    .bind(event.eventId, event.groupId, event.userId, event.eventTime, event.now + minutes * 60_000,
      JSON.stringify(turn), event.eventId, checkTaskId ?? null, checkTaskId ?? null)
}

export function trimConversation(db: D1Database, event: Actor) {
  return db.prepare(`DELETE FROM task_conversation WHERE rowid IN (
    SELECT rowid FROM task_conversation WHERE group_id = ? AND user_id = ?
    ORDER BY event_time DESC, rowid DESC LIMIT -1 OFFSET ?)`).bind(event.groupId, event.userId, limit)
}

export function expireConversation(db: D1Database, now: number) {
  return db.batch([
    db.prepare(`DELETE FROM task_conversation WHERE event_id IN (
      SELECT event_id FROM task_conversation WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`).bind(now),
    db.prepare(`DELETE FROM task_contexts WHERE rowid IN (
      SELECT rowid FROM task_contexts WHERE expires_at <= ? LIMIT 100)`).bind(now),
  ])
}
