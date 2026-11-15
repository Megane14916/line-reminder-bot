import { intentSchema, type TargetAction, type TaskAction } from './intent'
import { applyEvent, findTasks, getContext, getTask, listTasks, saveContext, type Task, type TaskEvent } from './repository'
import { changeReminderTime, defaultRule, describeSchedule, reminderSlots, ruleSchema } from './schedule'
import { todayInJapan } from './validation'

export const help = 'Bot にメンションして「12月20日までにレポート提出」「来週の締切を教えて」「レポート完了」「水筒の通知は前日21時だけ」などと送ってください。通知への引用返信で「終わった」と送っても完了できます。'
export const clarify = '操作を一つずつ、必要な日付やタスク名を添えて教えてください。'

export async function dispatchAction(db: D1Database, event: TaskEvent, action: TaskAction): Promise<string | undefined> {
  switch (action.type) {
    case 'help': return help
    case 'unknown': return `操作を読み取れませんでした。${help}`
    case 'clarify': return clarify
    case 'list_tasks': {
      const { tasks, truncated } = await listTasks(db, event.groupId, action)
      return tasks.length ? `${tasks.map(taskLine).join('\n')}${truncated ? '\n最初の20件を表示しています。' : ''}` : '該当するタスクはありません。'
    }
    case 'set_group_default': {
      const update = db.prepare(`INSERT INTO group_reminder_defaults (group_id, rule_json) VALUES (?, ?)
        ON CONFLICT(group_id) DO UPDATE SET rule_json = excluded.rule_json`).bind(event.groupId, JSON.stringify(action.rule))
      const reply = '今後登録するタスクの通知設定を変更しました。'
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
  const reply = `「${action.title}」を登録しました。期限 ${action.dueDate}\n通知 ${describeSchedule(rule, action.dueDate, event.now, event.now)}`
  if (await applyEvent(db, event, reply, insert, saveContext(db, event, action.type, 'new', null, true))) return reply
}

export async function answerSelection(db: D1Database, event: TaskEvent, id: number) {
  const context = await getContext(db, event)
  if (!context?.pending_json) return
  const pending: { action: unknown; ids: number[] } = JSON.parse(context.pending_json)
  if (!pending.ids.includes(id)) return '候補の #番号 を送ってください。'
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
      const reply = `どのタスクですか？ #番号 を送ってください。\n${options.map(taskLine).join('\n')}${candidates.length > 5 ? '\nほかにも候補があります。日付を添えると絞り込めます。' : ''}`
      if (await applyEvent(db, event, reply, saveContext(db, event, action.type, null, pending))) return reply
      return
    }
    task = candidates[0] ?? null
  } else {
    const id = target.by === 'id' ? target.id : (await getContext(db, event))?.task_id
    if (id) task = await getTask(db, event.groupId, id)
  }
  if (!task || (task.deleted_at !== null) !== (action.type === 'restore_task')) return '該当するタスクが見つかりません。タスク名や #番号 を教えてください。'
  return changeTask(db, event, action, task, target.by === 'recent' ? { recent: task.id } : undefined)
}

async function changeTask(db: D1Database, event: TaskEvent, action: TargetAction, task: Task,
  context?: { pending: string } | { recent: number }) {
  let rule = ruleSchema.parse(JSON.parse(task.reminder_rule))
  let anchor = task.reminder_anchor ?? task.created_at
  let { title, category, due_date: dueDate, status, deleted_at: deletedAt, reminder_enabled: enabled } = task
  let reply: string
  switch (action.type) {
    case 'get_reminder': {
      const reply = `「${title}」の通知 ${enabled && status === 'open' ? describeSchedule(rule, dueDate, anchor, event.now) : '停止中です。'}`
      if (await applyEvent(db, event, reply, saveContext(db, event, action.type, task.id))) return reply
      return
    }
    case 'update_task':
      if (action.dueDate && action.dueDate < todayInJapan(event.now)) return '過去の日付は締切に指定できません。'
      if (action.dueDate && action.dueDate !== dueDate) anchor = event.now
      title = action.title ?? title
      category = action.category ?? category
      dueDate = action.dueDate ?? dueDate
      reply = `「${title}」を変更しました。期限 ${dueDate}${action.dueDate ? '\n通知 ' + (enabled && status === 'open' ? describeSchedule(rule, dueDate, anchor, event.now) : '停止中です。') : ''}`
      break
    case 'complete_task':
      if (status === 'done') return `「${title}」は完了済みです。`
      status = 'done'
      reply = `「${title}」を完了にしました。`
      break
    case 'reopen_task':
      if (status === 'open') return `「${title}」は未完了です。`
      status = 'open'
      reply = `「${title}」の完了を取り消しました。`
      break
    case 'delete_task':
      deletedAt = event.now
      reply = `「${title}」を削除しました。`
      break
    case 'restore_task':
      deletedAt = null
      reply = `「${title}」を復元しました。`
      break
    case 'set_reminder':
      if (action.setting.by === 'time') rule = changeReminderTime(rule, action.setting.time, dueDate, anchor)
      else {
        rule = action.setting.rule
        anchor = event.now
      }
      enabled = 1
      reply = `「${title}」の通知を変更しました。\n${status === 'open' ? describeSchedule(rule, dueDate, anchor, event.now) : '完了を取り消すと通知が再開します。'}`
      break
    case 'disable_reminder':
      enabled = 0
      reply = `「${title}」の通知を停止しました。`
      break
    case 'enable_reminder':
      enabled = 1
      reply = `「${title}」の通知を再開しました。`
      break
  }
  const next = enabled && status === 'open' && deletedAt === null ? reminderSlots(rule, dueDate, anchor, event.now)[0] ?? null : null
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

function taskLine(task: Task) {
  return `#${task.id} ${task.due_date} ［${task.category === 'deadline' ? '期限' : '持ち物'}］${task.title}`
}
