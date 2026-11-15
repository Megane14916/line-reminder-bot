import { formatGroupReminderSettings, formatIntentError, formatReminderSettings, formatTaskCandidates,
  formatTaskList, formatTaskMessage, formatTaskResult, helpMessage } from '../line/messages'
import { intentSchema, type TargetAction, type TaskAction } from './intent'
import { askClarification } from './clarification'
import { applyEvent, findTasks, getContext, getTask, listTasks, mentionsOtherTask, pendingContext, saveContext,
  type Task, type TaskEvent } from './repository'
import { editReminder } from './reminder-edits'
import { applyNotificationPlan, configuredTimes } from './notification-plan'
import { notificationFocus } from './conversation'
import { formatNotificationChanges } from '../line/messages'
import { changeReminderTime, defaultRule, reminderSlots, ruleSchema } from './schedule'
import { todayInJapan } from './validation'

export async function dispatchAction(db: D1Database, event: TaskEvent, action: TaskAction): Promise<string | undefined> {
  switch (action.type) {
    case 'help': return helpMessage
    case 'unknown': return formatIntentError()
    case 'clarify': return action.question ? askClarification(db, event, action.question) : formatIntentError()
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
  if (await applyEvent(db, { ...event, linkTask: true }, reply, insert, saveContext(db, event, action.type, 'new', null, true))) return reply
}

export async function answerSelection(db: D1Database, event: TaskEvent, id: number) {
  const context = await getContext(db, event)
  const pending = pendingContext(context)
  if (!pending || pending.kind === 'clarification' || !context?.pending_json) return
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
  const deleted = action.type === 'restore_task'
  const quoteId = event.quoteTaskId
  let task: Task | null = null
  if (target.by === 'name') {
    const candidates = await findTasks(db, event.groupId, target.name, target.dueDate, deleted)
    if (quoteId && !candidates?.some(({ id }) => id === quoteId)) return quotationConflict
    if (!candidates?.length) return askClarification(db, event, 'task')
    if (quoteId) task = candidates.find(({ id }) => id === quoteId) ?? null
    else if (candidates.length > 1) {
      const options = candidates.slice(0, 5)
      const { target: _target, ...operation } = action
      const pending = JSON.stringify({ action: operation, ids: options.map(({ id }) => id) })
      const reply = formatTaskCandidates(options, candidates.length > 5, event.now)
      if (await applyEvent(db, event, reply, saveContext(db, event, action.type, null, pending))) return reply
      return
    } else task = candidates[0]
  } else {
    if (target.by === 'id' && quoteId && quoteId !== target.id) return quotationConflict
    const id = target.by === 'id' ? target.id : quoteId === undefined ? (await getContext(db, event))?.task_id : quoteId
    if (!id && target.by === 'recent') return askClarification(db, event, 'task')
    if (id) task = await getTask(db, event.groupId, id)
    if (target.by === 'recent' && task && event.text && await mentionsOtherTask(db, event.groupId, event.text, task.id, deleted)) {
      return quoteId ? quotationConflict : askClarification(db, event, 'task')
    }
  }
  if (!task || (task.deleted_at !== null) !== deleted) return '該当するタスクが見つかりません。タスク名や期限を教えてください。'
  return changeTask(db, event, action, task, target.by === 'recent' && quoteId === undefined ? { recent: task.id } : undefined)
}

const quotationConflict = '💬 引用したタスクと本文のタスク名が異なります。\n操作したいタスク名をメンション付きで送ってください。'

async function changeTask(db: D1Database, event: TaskEvent, action: TargetAction, task: Task,
  context?: { pending: string } | { recent: number }) {
  let rule = ruleSchema.parse(JSON.parse(task.reminder_rule))
  const beforeRule = rule
  let anchor = task.reminder_anchor ?? task.created_at
  let { title, category, due_date: dueDate, status, deleted_at: deletedAt, reminder_enabled: enabled } = task
  let heading: string
  let details = ''
  const observed = event.observedTask
  if (action.type === 'edit_notifications' && observed?.id === task.id && observed.version !== task.reminder_version) {
    return '🔔 通知設定が先に変更されました。現在の設定を確認して、もう一度送ってください。'
  }
  switch (action.type) {
    case 'get_reminder': {
      const active = Boolean(enabled && status === 'open' && deletedAt === null)
      const next = active ? reminderSlots(rule, dueDate, anchor, event.now)[0] ?? null : null
      const reply = formatReminderSettings('🔔 通知設定', title, { dueDate, rule, anchor, active, next }, event.now)
      if (await applyEvent(db, { ...event, linkTask: true }, reply, saveContext(db, event, action.type, task.id))) return reply
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
    case 'modify_reminder': {
      const edited = editReminder(rule, action.edit, dueDate, anchor, event.now)
      if (edited.kind === 'ask_day' || edited.kind === 'ask_time') {
        return askClarification(db, event, edited.kind === 'ask_day' ? 'day' : 'time', task.id)
      }
      if (edited.kind !== 'changed') {
        const notices = { duplicate: 'その通知はすでに設定されています。', missing: 'その通知は設定されていません。',
          limit: '通知設定の上限に達しています。' }
        const reply = formatTaskMessage('🔔 ' + notices[edited.kind], title)
        if (await applyEvent(db, { ...event, linkTask: true }, reply, saveContext(db, event, action.type, task.id))) return reply
        return
      }
      rule = edited.rule
      anchor = edited.anchor
      enabled = edited.stopped ? 0 : action.edit.mode === 'replace' ? 1 : enabled
      heading = edited.stopped ? '🔕 最後の通知を削除し、通知を停止しました'
        : action.edit.mode === 'remove' ? '🔔 通知を削除しました'
          : action.edit.mode === 'add' || action.edit.mode === 'add_time' ? '🔔 通知を追加しました' : '🔔 通知設定を変更しました'
      break
    }
    case 'edit_notifications': {
      const configured = await db.prepare('SELECT rule_json FROM group_reminder_defaults WHERE group_id = ?')
        .bind(event.groupId).first<string>('rule_json')
      const groupTimes = configured ? configuredTimes(ruleSchema.parse(JSON.parse(configured)), dueDate, event.now) : []
      const planned = applyNotificationPlan({ rule, anchor, dueDate, enabled: !!enabled, now: event.now,
        focus: notificationFocus(event.history ?? [], task.id, task.reminder_version),
        defaultTime: groupTimes.length === 1 ? groupTimes[0] : undefined }, action.edits)
      if (!planned.ok) {
        if (planned.reason === 'time' || planned.reason === 'day' || planned.reason === 'missing') {
          const prompt = planned.reason === 'missing'
            ? `🔔 ${planned.time ? planned.time + 'の' : '変更する'}通知が見つかりません。\nどの日の通知か教えてください。`
            : planned.time ? `🔔 ${planned.time}のどの通知を変更しますか？\n通知の日を教えてください。` : undefined
          return askClarification(db, event, planned.reason === 'time' ? 'time' : 'day', task.id, prompt)
        }
        if (planned.reason === 'past') return '🔔 過ぎた日時には通知を設定できません。'
        if (planned.reason === 'limit') return '🔔 通知設定の上限に達しています。'
        return askClarification(db, event, 'mode', task.id)
      }
      if (!planned.changes.length) {
        const reply = formatTaskMessage('🔔 その通知はすでに設定されています。', title)
        if (await applyEvent(db, { ...event, linkTask: true }, reply, saveContext(db, event, action.type, task.id))) return reply
        return
      }
      ;({ rule, anchor } = planned.state)
      enabled = Number(planned.state.enabled)
      const [change] = planned.changes
      heading = planned.changes.length > 1 || change.summary ? '🔔 通知設定を変更しました'
        : !change.before ? '🔔 通知を追加しました'
          : change.after ? '🔔 通知時刻を変更しました'
            : enabled ? '🔔 通知を削除しました' : '🔕 最後の通知を削除し、通知を停止しました'
      details = formatNotificationChanges(planned.changes, event.now)
      event.turn = { operation: action.type, taskId: task.id, version: task.reminder_version + 1,
        before: beforeRule, after: rule, changes: planned.changes }
      break
    }
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
    : action.type === 'set_reminder' || action.type === 'modify_reminder' || action.type === 'edit_notifications' ||
      action.type === 'disable_reminder' || action.type === 'enable_reminder'
      ? formatReminderSettings(heading, title, reminder, event.now) + details
      : formatTaskMessage(heading, title)
  const contextGuard = context ? `AND EXISTS (SELECT 1 FROM task_contexts WHERE group_id = ? AND user_id = ?
    AND ${'pending' in context ? 'pending_json' : 'task_id'} = ? AND expires_at > ? AND updated_at <= ?)` : ''
  const contextBindings = context ? [event.groupId, event.userId, 'pending' in context ? context.pending : context.recent, event.now, event.eventTime] : []
  const changes: D1PreparedStatement[] = []
  if (active && (action.type === 'edit_notifications' || action.type === 'update_task' ||
    action.type === 'modify_reminder' && ['add', 'add_time', 'remove'].includes(action.edit.mode))) {
    // Keep an already-queued, retained slot on its original delivery attempt, body and Retry Key.
    const { results } = await db.prepare(`SELECT scheduled_at FROM reminder_occurrences WHERE group_id = ? AND task_id = ?
      AND rule_version = ? AND status != 'sent' AND scheduled_at >= ?`)
      .bind(event.groupId, task.id, task.reminder_version, event.now - 60 * 60_000).all<{ scheduled_at: number }>()
    const retained = results.map(({ scheduled_at }) => scheduled_at).filter((at) => reminderSlots(rule, dueDate, anchor, at - 1)[0] === at)
    if (retained.length) changes.push(db.prepare(`UPDATE reminder_occurrences SET rule_version = rule_version + 1
      WHERE group_id = ? AND task_id = ? AND rule_version = ? AND status != 'sent'
        AND scheduled_at IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM tasks WHERE group_id = ? AND id = ? AND reminder_version = ? ${contextGuard})`)
      .bind(event.groupId, task.id, task.reminder_version, JSON.stringify(retained),
        event.groupId, task.id, task.reminder_version, ...contextBindings))
  }
  const update = db.prepare(`UPDATE tasks SET title = ?, category = ?, due_date = ?, status = ?, deleted_at = ?,
    completed_at = ?, reminder_rule = ?, reminder_enabled = ?, reminder_anchor = ?, next_reminder_at = ?,
    reminder_version = reminder_version + 1 WHERE group_id = ? AND id = ? AND reminder_version = ? ${contextGuard}`)
    .bind(title, category, dueDate, status, deletedAt, status === 'done' ? task.status === 'done' ? task.completed_at : event.now : null,
      JSON.stringify(rule), enabled, anchor, next, event.groupId, task.id, task.reminder_version,
      ...contextBindings)
  const unchanged = '操作結果を確認できませんでした。現在の状態を一覧で確認してください。'
  const results = await applyEvent(db, { ...event, linkTask: true }, { changed: reply, unchanged },
    ...changes, update, saveContext(db, event, action.type, task.id, null, true))
  if (results) return results.at(-2)?.meta.changes && results.at(-1)?.meta.changes ? reply : unchanged
}
