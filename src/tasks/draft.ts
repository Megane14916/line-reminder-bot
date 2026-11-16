import { intentSchema, type DialogueProposal, type TaskAction, type TaskDraft } from './intent'
import type { PendingDialogue } from './dialogue'
import { explicitNotificationDates, explicitNotificationTimes } from './notification-dates'
import { absoluteReminders, absoluteTime } from './schedule'
import { namesTarget } from './target-matching'
import { todayInJapan } from './validation'

type Evidence = NonNullable<PendingDialogue['evidence']>
type DraftResult = { action: TaskAction } | { pending: PendingDialogue }

export function dateTimeEvidence(text: string, now: number) {
  const dates = explicitNotificationDates(text, now).map(({ date }) => date)
  const times = explicitNotificationTimes(text)
  const valid = (value: string | undefined): value is string => value !== undefined
  return { dates: [...new Set(dates.filter(valid))], times: [...new Set(times.filter(valid))],
    invalidDay: dates.some((value) => !value), invalidTime: times.some((value) => !value) }
}

export function mergeDraft(draft: TaskDraft, patch: TaskDraft['fields'], text: string, now: number): TaskDraft {
  const { dates, times } = dateTimeEvidence(text, now)
  const fields = { ...draft.fields }
  if (patch.title && (!fields.title || namesTarget(text, patch.title))) fields.title = patch.title
  if (patch.category && (!fields.category || /持ち物|提出物|提出・期限/.test(text))) fields.category = patch.category
  if (patch.dueDate && dates.includes(patch.dueDate)) fields.dueDate = patch.dueDate
  if (patch.target && (!fields.target || patch.target.by === 'name' && namesTarget(text, patch.target.name))) fields.target = patch.target
  if (patch.notice?.kind === 'absolute' && fields.notice?.kind === 'absolute') {
    fields.notice = { kind: 'absolute', date: patch.notice.date && dates.includes(patch.notice.date) ? patch.notice.date : fields.notice.date,
      time: patch.notice.time && times.includes(patch.notice.time) ? patch.notice.time : fields.notice.time }
  } else if (patch.notice?.kind === 'relative' && fields.notice?.kind === 'relative') {
    fields.notice = { ...fields.notice, time: patch.notice.time && times.includes(patch.notice.time) ? patch.notice.time : fields.notice.time }
  } else if (patch.notice && (!fields.notice || patch.notice.kind === 'absolute' && patch.notice.date && dates.includes(patch.notice.date))) {
    fields.notice = patch.notice
  }
  return { ...draft, fields }
}

export function resolveDraft(draft: TaskDraft, original: string, originalAt: number, text: string, now: number,
  previous?: PendingDialogue): DraftResult {
  const originalEvidence = dateTimeEvidence(original, originalAt)
  const answer = dateTimeEvidence(text, now)
  const fields = { ...draft.fields }
  if (draft.operation === 'create_task' && !previous && !specifiesNotice(original, originalEvidence)) {
    delete fields.notice
    delete fields.rule
  }
  const before = previous?.draft?.fields
  const oldNotice = before?.notice?.kind === 'absolute' ? before.notice.date : undefined
  const noticeDate = fields.notice?.kind === 'absolute' ? fields.notice.date : undefined
  const replacedDates = [before?.dueDate, oldNotice].filter((date) => date && date !== fields.dueDate && date !== noticeDate)
  const oldTime = before?.notice?.time
  const replacedTime = oldTime && fields.notice?.time !== oldTime ? oldTime : undefined
  const evidence: Evidence = {
    dates: [...new Set([...(previous?.evidence?.dates ?? originalEvidence.dates).filter((date) => !replacedDates.includes(date)), ...answer.dates])],
    times: [...new Set([...(previous?.evidence?.times ?? originalEvidence.times).filter((time) => time !== replacedTime), ...answer.times])],
  }
  const pending = (question: PendingDialogue['question'], prompt: string): DraftResult =>
    ({ pending: { question, prompt, draft: { ...draft, fields }, originalAt, evidence } })
  if (answer.invalidDay) return pending('day', '📅 日付を確認して、もう一度教えてください。')
  if (answer.invalidTime) return pending('time', '🔔 時刻を確認して、もう一度教えてください。')
  if (draft.operation === 'create_task') {
    if (!fields.title) return pending('title', '💬 何のタスクを登録しますか？')
    const candidates = evidence.dates.filter((date) => fields.notice?.kind !== 'absolute' || date !== fields.notice.date)
    if (!fields.dueDate && candidates.length === 1) fields.dueDate = candidates[0]
    if (!fields.dueDate || (evidence.dates.length && !evidence.dates.includes(fields.dueDate)) || fields.dueDate < todayInJapan(now)) {
      return pending('day', '📅 タスクの日付はいつですか？')
    }
    fields.category ??= 'deadline'
  } else if (!fields.target) {
    return pending('task', '💬 どのタスクのことですか？')
  }

  let { notice } = fields
  if (notice) {
    if (notice.kind === 'absolute' && (!notice.date || !evidence.dates.includes(notice.date))) {
      return pending('day', '🔔 何日に通知しますか？')
    }
    if (notice.kind === 'relative' && notice.daysBefore === undefined) return pending('day', '🔔 何日前に通知しますか？')
    if (!notice.time && previous?.question === 'time' && answer.times.length === 1) {
      notice = { ...notice, time: answer.times[0] }
      fields.notice = notice
    }
    if (!notice.time || !evidence.times.includes(notice.time)) {
      const today = notice.kind === 'absolute' && notice.date === todayInJapan(now)
      return pending('time', today ? '🔔 今日の何時に通知しますか？' : '🔔 何時に通知しますか？')
    }
    if (notice.kind === 'absolute' && notice.date && absoluteTime({ date: notice.date, time: notice.time }) <= now) {
      return pending('time', '🔔 過ぎた時刻です。何時に通知しますか？')
    }
  }
  if (draft.operation === 'edit_notifications') {
    const result = intentSchema.safeParse({ type: 'edit_notifications', target: fields.target, edits: [{ op: 'add', when: notice }] })
    return result.success ? { action: result.data } : pending('day', '🔔 いつ通知しますか？')
  }
  const rule = notice ? notice.kind === 'absolute'
    ? { type: 'offsets', slots: [], absoluteSlots: [{ date: notice.date, time: notice.time }] }
    : { type: 'offsets', slots: [{ daysBefore: notice.daysBefore, time: notice.time }] } : fields.rule
  const result = intentSchema.safeParse({ type: 'create_task', title: fields.title, category: fields.category, dueDate: fields.dueDate, rule })
  if (!result.success || result.data.type !== 'create_task') return pending('day', '📅 タスクの日付はいつですか？')
  const checked = validateCreation(result.data, explicitEvidenceText(evidence), now)
  if (checked.type === 'clarify') {
    return checked.question === 'time' ? pending('time', '🔔 何時に通知しますか？') : pending('day', '📅 指定した日付を確認してください。')
  }
  return { action: checked }
}

function explicitEvidenceText(evidence: Evidence) {
  return [...evidence.dates, ...evidence.times].join('。')
}

export function validateCreation(action: Extract<TaskAction, { type: 'create_task' }>, text: string, now: number): TaskAction {
  const calendar = explicitNotificationDates(text, now)
  const times = explicitNotificationTimes(text)
  const absolutes = action.rule ? absoluteReminders(action.rule) : []
  if (calendar.some(({ date }) => !date) || absolutes.some((slot) => absoluteTime(slot) <= now)) return { type: 'clarify', question: 'day' }
  const dueDate = calendar.length === 1 && !absolutes.length && !calendar[0].time ? calendar[0].date! : action.dueDate
  if (calendar.some(({ date }) => date !== dueDate && !absolutes.some((slot) => slot.date === date))) return { type: 'clarify', question: 'day' }
  if (calendar.some(({ date, time }) => time && !absolutes.some((slot) => slot.date === date && slot.time === time))) {
    return { type: 'clarify', question: 'time' }
  }
  const ruleTimes = action.rule?.type === 'repeat' ? action.rule.times : action.rule?.type === 'offsets' ? action.rule.slots.map((slot) => slot.time) : []
  if (times.some((time) => !time || !ruleTimes.includes(time) && !absolutes.some((slot) => slot.time === time))) {
    return { type: 'clarify', question: 'time' }
  }
  return { ...action, dueDate }
}

function specifiesNotice(text: string, evidence: ReturnType<typeof dateTimeEvidence>) {
  return evidence.dates.length > 1 || evidence.times.length > 0 ||
    /通知|知らせ|リマインド|毎日|毎週|日おき|日前にも|前日にも/.test(text)
}

// An addition or clock proposal can be grounded in the calendar evidence of the current turn.
export function groundTemporalDraft(action: TaskAction, text: string, now: number, pending?: PendingDialogue): DialogueProposal | undefined {
  if (action.type !== 'edit_notifications' || action.edits.length !== 1) return
  const [edit] = action.edits
  const evidence = dateTimeEvidence(text, now)
  if (evidence.invalidDay || evidence.invalidTime) return
  if (pending?.question === 'time' && pending.draft?.fields.notice && action.target.by === 'recent' && evidence.times.length === 1 &&
    (edit.op === 'set_clock' || edit.op === 'add_clock') && edit.time === evidence.times[0]) {
    const notice = pending.draft.fields.notice
    const date = notice.kind === 'absolute' && evidence.dates.length === 1 ? evidence.dates[0] : undefined
    return { type: 'continue', fields: { notice: { ...notice, ...(date ? { date } : {}), time: edit.time } } }
  }
  if (!pending && (edit.op === 'add' || edit.op === 'add_clock') && evidence.dates.length === 1 && !evidence.times.length) {
    return { type: 'draft', operation: 'edit_notifications', fields: { target: action.target,
      notice: { kind: 'absolute', date: evidence.dates[0] } } }
  }
}
