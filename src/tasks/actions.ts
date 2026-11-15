import { formatGroupReminderSettings, formatIntentError, formatReminderSettings, formatTaskCandidates,
  formatTaskList, formatTaskMessage, formatTaskResult, helpMessage } from '../line/messages'
import { intentSchema, type TargetAction, type TaskAction } from './intent'
import { applyEvent, findTasks, getContext, getTask, listTasks, saveContext, type Task, type TaskEvent } from './repository'
import { changeReminderTime, defaultRule, reminderSlots, ruleSchema } from './schedule'
import { todayInJapan } from './validation'

export async function dispatchAction(db: D1Database, event: TaskEvent, action: TaskAction): Promise<string | undefined> {
  switch (action.type) {
    case 'help': return helpMessage
    case 'unknown': return formatIntentError()
    case 'clarify': return formatIntentError(true)
    case 'list_tasks': {
      const { tasks, truncated } = await listTasks(db, event.groupId, action)
      return formatTaskList(tasks, action.status, truncated, event.now)
    }
    case 'set_group_default': {
      const update = db.prepare(`INSERT INTO group_reminder_defaults (group_id, rule_json) VALUES (?, ?)
        ON CONFLICT(group_id) DO UPDATE SET rule_json = excluded.rule_json`).bind(event.groupId, JSON.stringify(action.rule))
      const reply = formatGroupReminderSettings(action.rule)
      if (await applyEvent(db, event, reply, update)) return reply
      return
    }
    case 'create_task': return createTask(db, event, action)
    default: return targetOperation(db, event, action)
  }
}

async function createTask(db: D1Database, event: TaskEvent, action: Extract<TaskAction, { type: 'create_task' }>) {
  if (action.dueDate < todayInJapan(event.now)) return '過去の日付は締切に指定できません。'
  const configured = action.rule ? null : await db.prepare('SELECT rule_json FROM group_reminder_defaults WHERE group_id = ?')
    .bind(event.groupId).first<string>('rule_json')
  const rule = action.rule ?? (configured ? ruleSchema.parse(JSON.parse(configured)) : defaultRule)
  const next = reminderSlots(rule, action.dueDate, event.now, event.now)[0] ?? null
  const insert = db.prepare(`INSERT INTO tasks (group_id, category, title, due_date, created_by, created_at,
    reminder_rule, reminder_anchor, next_reminder_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.groupId, action.category, action.title, action.dueDate, event.userId, event.now, JSON.stringify(rule), event.now, next)
  const reply = formatTaskResult('✅ タスクを登録しました', action.title, action.category,
    { dueDate: action.dueDate, rule, anchor: event.now, active: true, next }, event.now)
  if (await applyEvent(db, event, reply, insert, saveContext(db, event, action.type, 'new', null, true))) return reply
}

export async function answerSelection(db: D1Database, event: TaskEvent, id: number) {
  const context = await getContext(db, event)
  if (!context?.pending_json) return
  const pending: { action: unknown; ids: number[] } = JSON.parse(context.pending_json)
  if (!pending.ids.includes(id)) return '候補にある選択用の番号を、#も付けて送ってください。'
  const selected = intentSchema.safeParse({ ...(pending.action as object), target: { by: 'id', id } })
  if (selected.success && 'target' in selected.data) {
    const task = await getTask(db, event.groupId, id)
    if (!task || (task.deleted_at !== null) !== (selected.data.type === 'restore_task')) return '該当するタスクが見つかりません。'
    return changeTask(db, event, selected.data, task, { pending: context.pending_json })
  }
}

async function targetOperation(db: D1Database, event: TaskEvent, action: TargetAction) {
  const target = action.target
  let task: Task | null = null
  if (target.by === 'name') {
    const candidates = await findTasks(db, event.groupId, target.name, target.dueDate, action.type === 'restore_task')
    if (candidates.length > 1) {
      const options = candidates.slice(0, 5)
      const { target: _target, ...operation } = action
      const pending = JSON.stringify({ action: operation, ids: options.map(({ id }) => id) })
      const reply = formatTaskCandidates(options, candidates.length > 5, event.now)
      if (await applyEvent(db, event, reply, saveContext(db, event, action.type, null, pending))) return reply
      return
    }
    task = candidates[0] ?? null
  } else {
    const id = target.by === 'id' ? target.id : (await getContext(db, event))?.task_id
    if (id) task = await getTask(db, event.groupId, id)
  }
  if (!task || (task.deleted_at !== null) !== (action.type === 'restore_task')) return '該当するタスクが見つかりません。タスク名や期限を教えてください。'
  return changeTask(db, event, action, task, target.by === 'recent' ? { recent: task.id } : undefined)
}

async function changeTask(db: D1Database, event: TaskEvent, action: TargetAction, task: Task,
  context?: { pending: string } | { recent: number }) {
  let rule = ruleSchema.parse(JSON.parse(task.reminder_rule))
  let anchor = task.reminder_anchor ?? task.created_at
  let { title, category, due_date: dueDate, status, deleted_at: deletedAt, reminder_enabled: enabled } = task
  let heading: string
  switch (action.type) {
    case 'get_reminder': {
      const active = Boolean(enabled && status === 'open' && deletedAt === null)
      const next = active ? reminderSlots(rule, dueDate, anchor, event.now)[0] ?? null : null
      const reply = formatReminderSettings('🔔 通知設定', title, { dueDate, rule, anchor, active, next }, event.now)
      if (await applyEvent(db, event, reply, saveContext(db, event, action.type, task.id))) return reply
      return
    }
    case 'update_task':
      if (action.dueDate && action.dueDate < todayInJapan(event.now)) return '過去の日付は締切に指定できません。'
      if (action.dueDate && action.dueDate !== dueDate) anchor = event.now
      title = action.title ?? title
      category = action.category ?? category
      dueDate = action.dueDate ?? dueDate
      heading = '✏️ タスクを変更しました'
      break
    case 'complete_task':
      if (status === 'done') return formatTaskMessage('✅ このタスクは完了済みです', title)
      status = 'done'
      heading = '✅ タスクを完了にしました'
      break
    case 'reopen_task':
      if (status === 'open') return formatTaskMessage('↩️ このタスクは未完了です', title)
      status = 'open'
      heading = '↩️ タスクの完了を取り消しました'
      break
    case 'delete_task':
      deletedAt = event.now
      heading = '🗑️ タスクを削除しました'
      break
    case 'restore_task':
      deletedAt = null
      heading = '↩️ タスクを復元しました'
      break
    case 'set_reminder':
      if (action.setting.by === 'time') rule = changeReminderTime(rule, action.setting.time, dueDate, anchor)
      else {
        rule = action.setting.rule
        anchor = event.now
      }
      enabled = 1
      heading = '🔔 通知設定を変更しました'
      break
    case 'disable_reminder':
      enabled = 0
      heading = '🔕 通知を停止しました'
      break
    case 'enable_reminder':
      enabled = 1
      heading = status === 'open' ? '🔔 通知を再開しました' : '🔔 通知設定を変更しました'
      break
  }
  const active = Boolean(enabled && status === 'open' && deletedAt === null)
  const next = active ? reminderSlots(rule, dueDate, anchor, event.now)[0] ?? null : null
  const reminder = { dueDate, rule, anchor, active, next }
  const reply = action.type === 'update_task' ? formatTaskResult(heading, title, category, reminder, event.now)
    : action.type === 'set_reminder' || action.type === 'disable_reminder' || action.type === 'enable_reminder'
      ? formatReminderSettings(heading, title, reminder, event.now)
      : formatTaskMessage(heading, title)
  const contextGuard = context ? `AND EXISTS (SELECT 1 FROM task_contexts WHERE group_id = ? AND user_id = ?
    AND ${'pending' in context ? 'pending_json' : 'task_id'} = ? AND expires_at > ? AND updated_at <= ?)` : ''
  const update = db.prepare(`UPDATE tasks SET title = ?, category = ?, due_date = ?, status = ?, deleted_at = ?,
    completed_at = ?, reminder_rule = ?, reminder_enabled = ?, reminder_anchor = ?, next_reminder_at = ?,
    reminder_version = reminder_version + 1 WHERE group_id = ? AND id = ? AND reminder_version = ? ${contextGuard}`)
    .bind(title, category, dueDate, status, deletedAt, status === 'done' ? task.status === 'done' ? task.completed_at : event.now : null,
      JSON.stringify(rule), enabled, anchor, next, event.groupId, task.id, task.reminder_version,
      ...(context ? [event.groupId, event.userId, 'pending' in context ? context.pending : context.recent, event.now, event.eventTime] : []))
  const unchanged = '操作結果を確認できませんでした。現在の状態を一覧で確認してください。'
  const results = await applyEvent(db, event, { changed: reply, unchanged }, update, saveContext(db, event, action.type, task.id, null, true))
  if (results) return results[0].meta.changes && results[1].meta.changes ? reply : unchanged
}
