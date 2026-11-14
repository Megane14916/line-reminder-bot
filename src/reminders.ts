import { sendPush } from './line/client'
import type { TaskCategory } from './tasks/repository'
import { todayInJapan } from './tasks/validation'

const dayMs = 24 * 60 * 60 * 1000
const maxTextLength = 5000

type ReminderTask = { group_id: string; category: TaskCategory; title: string }

export async function sendDeadlineReminders({ DB, LINE_CHANNEL_ACCESS_TOKEN: accessToken }: Env, scheduledTime: number) {
  const targetDate = todayInJapan(scheduledTime + dayMs)
  const { results } = await DB.prepare(`
    SELECT group_id, category, title FROM tasks
    WHERE status = 'open' AND due_date = ? AND created_at <= ?
    ORDER BY group_id, id
  `).bind(targetDate, scheduledTime).all<ReminderTask>()
  if (!results.length) return
  if (!accessToken) throw new Error('LINE channel access token is not configured')

  const groups = new Map<string, ReminderTask[]>()
  for (const task of results) {
    const tasks = groups.get(task.group_id)
    if (tasks) tasks.push(task)
    else groups.set(task.group_id, [task])
  }

  for (const [groupId, tasks] of groups) {
    const text = formatReminder(targetDate, tasks)
    const retryKey = crypto.randomUUID()
    const claim = await DB.prepare(`
      INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (group_id, target_due_date) DO NOTHING
    `).bind(groupId, targetDate, text, retryKey, Date.now()).run()
    // A pending row also blocks repeat sends if the Worker stops mid-request.
    if (!claim.meta.changes) continue

    const result = await sendPush(accessToken, groupId, text, retryKey)
    const httpStatus = !result.ok && result.kind === 'http' ? result.status : null
    if (!result.ok) {
      console.error('LINE deadline reminder failed', { retryKey, targetDate, kind: result.kind, httpStatus })
    }
    await DB.prepare(`
      UPDATE notification_batches SET status = ?, http_status = ?, sent_at = ?
      WHERE group_id = ? AND target_due_date = ?
    `).bind(result.ok ? 'sent' : 'failed', httpStatus, result.ok ? Date.now() : null, groupId, targetDate).run()
  }
}

function formatReminder(targetDate: string, tasks: ReminderTask[]) {
  let text = `明日（${targetDate}）が期限のタスク（${tasks.length}件）`
  for (const [index, task] of tasks.entries()) {
    const category = task.category === 'deadline' ? '期限' : '持ち物'
    const line = `\n・［${category}］${task.title}`
    const remaining = tasks.length - index
    if (text.length + line.length + `\nほか${remaining}件`.length > maxTextLength) {
      return `${text}\nほか${remaining}件`
    }
    text += line
  }
  return text
}
