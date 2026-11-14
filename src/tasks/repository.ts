export type TaskCategory = 'deadline' | 'belonging'
export type Task = { id: number; title: string; due_date: string; category: TaskCategory }
export type TaskDraft = { category: TaskCategory; title: string; dueDate: string }

type Session =
  | { state: 'awaiting_input'; payload: { category: TaskCategory } }
  | { state: 'confirm_create'; payload: TaskDraft }
  | { state: 'confirm_delete'; payload: { taskId: number } }

type StoredSession = Session & { token: string }
export type TaskEvent = {
  groupId: string
  userId: string
  eventId: string
  eventTime: number
  now: number
}

const sessionDuration = 10 * 60 * 1000
export const taskListLimit = 20

export async function listTasks(db: D1Database, groupId: string) {
  const { results } = await db.prepare(`
    SELECT id, title, due_date, category FROM tasks
    WHERE group_id = ? AND status = 'open' ORDER BY due_date, id LIMIT ?
  `).bind(groupId, taskListLimit + 1).all<Task>()
  return { tasks: results.slice(0, taskListLimit), truncated: results.length > taskListLimit }
}

export function findOpenTask(db: D1Database, groupId: string, taskId: number) {
  return db.prepare(`
    SELECT id, title, due_date, category FROM tasks WHERE group_id = ? AND id = ? AND status = 'open'
  `).bind(groupId, taskId).first<Task>()
}

export async function getSession(db: D1Database, event: TaskEvent): Promise<StoredSession | undefined> {
  const row = await db.prepare(`
    SELECT state, payload_json, token FROM interaction_sessions
    WHERE group_id = ? AND user_id = ? AND expires_at > ? AND updated_at <= ?
  `).bind(event.groupId, event.userId, event.now, event.eventTime)
    .first<{ state: Session['state']; payload_json: string; token: string }>()

  if (row) return { state: row.state, token: row.token, payload: JSON.parse(row.payload_json) }
}

export function startSession(db: D1Database, event: TaskEvent, session: StoredSession) {
  return db.prepare(`
    INSERT INTO interaction_sessions (group_id, user_id, state, token, payload_json, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (group_id, user_id) DO UPDATE SET
      state = excluded.state, token = excluded.token, payload_json = excluded.payload_json,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at
    WHERE interaction_sessions.updated_at <= excluded.updated_at
  `).bind(event.groupId, event.userId, session.state, session.token,
    JSON.stringify(session.payload), event.now + sessionDuration, event.eventTime)
}

export function confirmDraft(db: D1Database, event: TaskEvent, inputToken: string, token: string, draft: TaskDraft) {
  return db.prepare(`
    UPDATE interaction_sessions SET state = 'confirm_create', token = ?, payload_json = ?, expires_at = ?, updated_at = ?
    WHERE group_id = ? AND user_id = ? AND state = 'awaiting_input' AND token = ? AND expires_at > ? AND updated_at <= ?
  `).bind(token, JSON.stringify(draft), event.now + sessionDuration, event.eventTime,
    event.groupId, event.userId, inputToken, event.now, event.eventTime)
}

const matchesSession = `group_id = ? AND user_id = ? AND token = ? AND expires_at > ? AND updated_at <= ?`

function sessionBindings(event: TaskEvent, token: string) {
  return [event.groupId, event.userId, token, event.now, event.eventTime] as const
}

export function insertTask(db: D1Database, event: TaskEvent, token: string, draft: TaskDraft) {
  return db.prepare(`
    INSERT INTO tasks (group_id, category, title, due_date, created_by, created_at)
    SELECT ?, ?, ?, ?, ?, ? FROM interaction_sessions WHERE ${matchesSession} AND state = 'confirm_create'
  `).bind(event.groupId, draft.category, draft.title, draft.dueDate, event.userId, event.now,
    ...sessionBindings(event, token))
}

export function completeTask(db: D1Database, event: TaskEvent, taskId: number) {
  return db.prepare(`
    UPDATE tasks SET status = 'done', completed_at = ? WHERE group_id = ? AND id = ? AND status = 'open'
  `).bind(event.now, event.groupId, taskId)
}

export function deleteTask(db: D1Database, event: TaskEvent, token: string, taskId: number) {
  return db.prepare(`
    DELETE FROM tasks WHERE group_id = ? AND id = ? AND status = 'open'
      AND EXISTS (SELECT 1 FROM interaction_sessions WHERE ${matchesSession} AND state = 'confirm_delete')
  `).bind(event.groupId, taskId, ...sessionBindings(event, token))
}

export function consumeSession(db: D1Database, event: TaskEvent, token: string) {
  return db.prepare(`
    UPDATE interaction_sessions SET state = 'idle', payload_json = '{}', expires_at = 0, updated_at = ?
    WHERE ${matchesSession}
  `).bind(event.eventTime, ...sessionBindings(event, token))
}

export async function applyEvent(db: D1Database, event: TaskEvent, ...changes: D1PreparedStatement[]) {
  const record = db.prepare('INSERT INTO processed_events (event_id, processed_at) VALUES (?, ?)')
    .bind(event.eventId, event.now)

  try {
    // A duplicate event rolls back the whole batch, including every state change.
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
