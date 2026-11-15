import type { Task, TaskCategory } from '../tasks/repository'
import { defaultReminderOffsets, type ReminderRule } from '../tasks/schedule'
import { daysUntil, todayInJapan } from '../tasks/validation'

const timeZone = 'Asia/Tokyo'
const dateOptions = { timeZone, month: 'long', day: 'numeric', weekday: 'short' } as const
const shortDate = new Intl.DateTimeFormat('ja-JP', dateOptions)
const fullDate = new Intl.DateTimeFormat('ja-JP', { ...dateOptions, year: 'numeric' })
const time = new Intl.DateTimeFormat('ja-JP', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const weekdays = ['日', '月', '火', '水', '木', '金', '土']
const categories = { deadline: '提出物', belonging: '持ち物' }

export function formatTaskDate(date: string, now: number) {
  const at = Date.parse(`${date}T00:00:00+09:00`)
  if (!Number.isFinite(at) || todayInJapan(at) !== date) return date
  const formatter = date.slice(0, 4) === todayInJapan(now).slice(0, 4) ? shortDate : fullDate
  return formatter.format(at).replace('(', '（').replace(')', '）')
}

function formatTitle(title: string) {
  // A legacy title can have 100 Unicode characters, or up to 200 UTF-16 units.
  const chars = [...title.replace(/[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ').trim()]
  return (chars.length > 100 ? chars.slice(0, 99).join('') + '…' : chars.join('')) || '（名前なし）'
}

export function formatTaskMessage(heading: string, title: string) {
  return `${heading}\n\n${formatTitle(title)}`
}

function listDetails(task: Task, now: number) {
  return `期限：${formatTaskDate(task.due_date, now)}｜${categories[task.category]}`
}

export function formatTaskList(tasks: Task[], status: 'open' | 'done' | 'deleted' | undefined, truncated: boolean, now: number) {
  if (!tasks.length) return '該当するタスクはありません。'
  const labels = { open: '未完了のタスク', done: '完了済みのタスク', deleted: '削除済みのタスク' }
  const blocks = tasks.map((task) => `${formatTitle(task.title)}\n${listDetails(task, now)}`)
  if (truncated) blocks.push(`最初の${tasks.length}件を表示しています。`)
  return [`📋 ${labels[status ?? 'open']}（${tasks.length}件）`, ...blocks].join('\n\n')
}

export function formatTaskCandidates(tasks: Task[], truncated: boolean, now: number) {
  const blocks = tasks.map((task) => `#${task.id} ${formatTitle(task.title)}\n${listDetails(task, now)}`)
  if (truncated) blocks.push('ほかにも候補があります。期限を添えると絞り込めます。')
  return ['🔎 どのタスクですか？\n選択用の番号を、#も付けてメンションなしで送ってください。', ...blocks].join('\n\n')
}

type TaskReminder = {
  dueDate: string
  rule: ReminderRule
  anchor: number
  active: boolean
  next: number | null
}

function offsetLabel(days: number) {
  if (days === 0) return '当日'
  if (days === 1) return '前日'
  return `${days}日前`
}

type Offset = Extract<ReminderRule, { type: 'offsets' }>['slots'][number]

function formatOffsets(offsets: Offset[]) {
  const slots = [...offsets].sort((a, b) => b.daysBefore - a.daysBefore || a.time.localeCompare(b.time))
  const times = new Set(slots.map((slot) => slot.time))
  if (times.size === 1) {
    const days = [...new Set(slots.map((slot) => offsetLabel(slot.daysBefore)))]
    return `通知：${days.join('・')} ${slots[0].time}`
  }
  const entries = [...new Set(slots.map((slot) => `・${offsetLabel(slot.daysBefore)} ${slot.time}`))]
  return ['通知：', ...entries].join('\n')
}

function formatRepeat(rule: Extract<ReminderRule, { type: 'repeat' }>, startLabel: string) {
  const from = rule.startDaysBefore === null ? startLabel : offsetLabel(rule.startDaysBefore)
  const through = offsetLabel(rule.endDaysBefore)
  const times = [...new Set(rule.times)].sort()
  const days = [...new Set(rule.weekdays)].sort((a, b) => (a + 6) % 7 - (b + 6) % 7)
  const weekdayNames = days.map((day) => weekdays[day] + '曜日').join('・')
  const frequency = days.length ? `毎週${weekdayNames}`
    : rule.everyDays === 1 ? '毎日' : `${rule.everyDays}日おき`
  const period = rule.startDaysBefore === rule.endDaysBefore
    ? through + (weekdayNames ? `（${weekdayNames}の場合）` : '')
    : `${from}から${through}まで${frequency}`
  const when = times.length === 1 ? `時刻：${times[0]}` : ['時刻：', ...times.map((slot) => `・${slot}`)].join('\n')
  return `通知：${period}\n${when}`
}

function reminderDetails({ dueDate, rule, anchor, active, next }: TaskReminder, now: number, showNext: boolean) {
  if (!active) return '通知：停止中'
  const summary = rule.type === 'repeat' ? formatRepeat(rule, '設定日')
    : formatOffsets(rule.type === 'default' ? defaultReminderOffsets(dueDate, anchor) : rule.slots)
  if (next === null) return `${summary}\n今後の通知予定はありません。`
  if (!showNext) return summary
  return `${summary}\n次回：${formatTaskDate(todayInJapan(next), now)}${time.format(next)}`
}

export function formatTaskResult(heading: string, title: string, category: TaskCategory, reminder: TaskReminder, now: number) {
  return [formatTaskMessage(heading, title), `期限：${formatTaskDate(reminder.dueDate, now)}`,
    `種類：${categories[category]}`, reminderDetails(reminder, now, false)].join('\n')
}

export function formatReminderSettings(heading: string, title: string, reminder: TaskReminder, now: number) {
  return [formatTaskMessage(heading, title), `期限：${formatTaskDate(reminder.dueDate, now)}`,
    reminderDetails(reminder, now, true)].join('\n')
}

export function formatGroupReminderSettings(rule: ReminderRule) {
  const summary = rule.type === 'repeat' ? formatRepeat(rule, '登録日')
    : rule.type === 'offsets' ? formatOffsets(rule.slots)
      : '通知：前日 20:00（期限まで8日以上あれば7日前の20:00にも通知）'
  return `🔔 今後登録するタスクの通知設定を変更しました\n\n${summary}`
}

export function formatReminderMessage(title: string, dueDate: string, slot: number) {
  const days = daysUntil(dueDate, slot)
  const countdown = days === 0 ? '今日が締切です' : days === 1 ? '明日が締切です' : `締切まであと${days}日`
  return `${formatTaskMessage('🔔 リマインダー', title)}\n期限：${formatTaskDate(dueDate, slot)}\n${countdown}`
}

export const helpMessage = [
  '📖 Botの使い方',
  'Botをメンションして、やりたいことを文章で送ってください。',
  '📝 タスクの登録\n「12月20日までにレポート提出」',
  '📋 タスクの確認\n「来週の締切を教えて」',
  '✏️ タスクの変更\n「レポートの期限を12月23日に変更して」',
  '✅ タスクの完了\n「レポート終わった」',
  '🔔 通知の設定\n「レポートは1週間前から毎日20時に通知して」\n「レポートの通知は前日だけにして」',
  '💬 通知への返信\nリマインダーを引用して「終わった」と返信すると完了できます。メンションは不要です。',
].join('\n\n')

export function formatIntentError(needsDetails = false) {
  const prompt = needsDetails ? '操作を一つずつ、日付やタスク名を添えて送ってください。'
    : '操作を読み取れませんでした。日付やタスク名を添えて、もう一度お試しください。'
  return `💬 ${prompt}\n\n${helpMessage}`
}
