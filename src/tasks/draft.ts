import { intentSchema, type DialogueProposal, type DraftEditPatch, type TaskAction, type TaskDraft } from './intent'
import type { PendingDialogue } from './dialogue'
import { explicitNotificationDates, explicitNotificationTimes, notificationPeriod, relativeDays } from './notification-dates'
import { absoluteReminders, absoluteTime, type ReminderRule } from './schedule'
import { resolveNotificationClock } from './notification-clock'
import type { NotificationChange } from './notification-plan'
import { namesTarget } from './target-matching'
import { todayInJapan } from './validation'
import { draftEdits, justifiedRemovals, nextEditQuestion, reconcileEditedDraft } from './draft-edits'

type Evidence = NonNullable<PendingDialogue['evidence']>
type DraftResult = { action: TaskAction; change?: NotificationChange } | { pending: PendingDialogue } | { error: string }
type Continuation = { type?: 'continue' | 'draft'; fields: TaskDraft['fields']; patches?: DraftEditPatch[] }

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
  if (patch.title && (!fields.title || groundedTitle(text, patch.title))) fields.title = patch.title
  if (patch.category && (!fields.category || /持ち物|提出物|提出・期限/.test(text))) fields.category = patch.category
  if (patch.dueDate && dates.includes(patch.dueDate)) fields.dueDate = patch.dueDate
  if (patch.target && (!fields.target || patch.target.by === 'name' && namesTarget(text, patch.target.name))) fields.target = patch.target
  if (patch.notice?.kind === 'absolute' && fields.notice?.kind === 'absolute') {
    fields.notice = { kind: 'absolute', date: patch.notice.date && dates.includes(patch.notice.date) ? patch.notice.date : fields.notice.date,
      time: patch.notice.time && times.includes(patch.notice.time) ? patch.notice.time : fields.notice.time }
  } else if (patch.notice?.kind === 'relative' && fields.notice?.kind === 'relative') {
    fields.notice = { ...fields.notice, daysBefore: patch.notice.daysBefore !== undefined &&
      relativeDays(text.normalize('NFKC')).includes(patch.notice.daysBefore) ? patch.notice.daysBefore : fields.notice.daysBefore,
    time: patch.notice.time && times.includes(patch.notice.time) ? patch.notice.time : fields.notice.time }
  } else if (patch.notice && (!fields.notice || patch.notice.kind === 'absolute' && patch.notice.date && dates.includes(patch.notice.date))) {
    fields.notice = patch.notice
  }
  return { ...draft, fields }
}

// A new title must appear in the current turn before it can replace an existing conversation.
export function groundedTitle(text: string, title: string) {
  return namesTarget(text.replace(/を(?=持|書|出|申|買)/g, ''), title.replace(/を(?=持|書|出|申|買)/g, ''))
}

export function hasDifferentQuotedSubject(text: string, quotedTitle: string, now: number) {
  const date = explicitNotificationDates(text, now).find((entry) => entry.date && entry.index === 0)
  const subject = date && /^\s*(?:の|に)?([^、。]{2,30}?)(?:を)?(?:持っていく|持ってく|持参する|提出する|書く|買う)(?:から|ので)/.exec(text.slice(date.end))?.[1]
  return !!subject && !/^(?:これ|それ|あれ|さっき|この|その)/.test(subject) && !namesTarget(quotedTitle, subject) &&
    !groundedTitle(text, quotedTitle)
}

export function continuationFields(action: TaskAction, draft: TaskDraft): Continuation | undefined {
  if (action.type === 'edit_notifications' && draft.operation === 'edit_notifications') {
    return { fields: { target: action.target, edits: action.edits } }
  }
  if (action.type !== 'create_task' || draft.operation !== 'create_task') return
  const { title, dueDate, category, rule } = action
  if (draft.fields.notice && rule) {
    if (rule.type !== 'offsets') return
    const absolute = rule.absoluteSlots ?? []
    if (absolute.length + rule.slots.length !== 1) return
    const notice = absolute.length === 1 ? { kind: 'absolute' as const, ...absolute[0] } : { kind: 'relative' as const, ...rule.slots[0] }
    return { fields: { title, dueDate, category, notice } }
  }
  return { fields: { title, dueDate, category, rule } }
}

export function reconcileDraft(pending: PendingDialogue & { draft: TaskDraft }, update: Continuation, original: string, text: string, now: number,
  requireCancellation = false) {
  const { draft } = pending
  const old = draft.fields
  const patch = update.fields
  const evidence = dateTimeEvidence(text, now)
  if (old.target && patch.target && JSON.stringify(old.target) !== JSON.stringify(patch.target)) return
  if (patch.target?.by === 'id' && old.target?.by !== 'id') return
  if (draft.operation === 'edit_notifications') {
    if (patch.title || patch.dueDate || patch.category || patch.rule) return
    const result = reconcileEditedDraft(old, update, text, now, pending.editText ?? original, pending.originalAt, requireCancellation)
    if (!result) return
    return { draft: { ...draft, fields: { target: old.target ?? patch.target, edits: result.edits } },
      pending: { ...pending, editText: result.editText } }
  }
  if (patch.target || patch.edits || update.patches || patch.rule && JSON.stringify(patch.rule) !== JSON.stringify(old.rule)) return
  if (patch.title && patch.title !== old.title && !groundedTitle(text, patch.title)) return
  if (patch.category && old.category && patch.category !== old.category && !/持ち物|提出物|提出・期限/.test(text)) return
  if (patch.dueDate && patch.dueDate !== old.dueDate && !evidence.dates.includes(patch.dueDate)) return
  if (patch.notice?.time && patch.notice.time !== old.notice?.time && !evidence.times.includes(patch.notice.time)) return
  if (patch.notice?.kind === 'absolute' && patch.notice.date &&
    (old.notice?.kind !== 'absolute' || patch.notice.date !== old.notice.date) && !evidence.dates.includes(patch.notice.date)) return
  if (patch.notice?.kind === 'relative' && patch.notice.daysBefore !== undefined &&
    (old.notice?.kind !== 'relative' || patch.notice.daysBefore !== old.notice.daysBefore) &&
    !relativeDays(text.normalize('NFKC')).includes(patch.notice.daysBefore)) return
  if (old.notice && patch.notice && old.notice.kind !== patch.notice.kind) return
  return { draft: mergeDraft(draft, patch, text, now), pending }
}

export function resolveDraft(draft: TaskDraft, original: string, originalAt: number, text: string, now: number,
  previous?: PendingDialogue, groupRule?: ReminderRule): DraftResult {
  const originalEvidence = dateTimeEvidence(original, originalAt)
  const answer = dateTimeEvidence(text, now)
  const fields = { ...draft.fields }
  const editText = draft.operation === 'edit_notifications' ? previous?.editText ?? original : undefined
  if (draft.operation === 'edit_notifications') {
    fields.edits = draftEdits(fields)
    delete fields.notice
  }
  if (draft.operation === 'create_task' && !previous && !specifiesNotice(original, originalEvidence)) {
    delete fields.notice
    delete fields.rule
  }
  const implicitNight = draft.operation === 'create_task' && /(?:今夜|夜に)通知して/.test(original) && originalEvidence.dates.length === 1 &&
    fields.dueDate && fields.dueDate > todayInJapan(originalAt)
  if (implicitNight && (!fields.notice || fields.notice.kind === 'absolute' &&
    (!fields.notice.date || fields.notice.date === todayInJapan(originalAt)))) {
    fields.notice = { kind: 'absolute', date: todayInJapan(originalAt), time: fields.notice?.time }
    originalEvidence.dates.push(todayInJapan(originalAt))
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
    ({ pending: { question, prompt, draft: { ...draft, fields }, originalAt, evidence, editText, observedTask: previous?.observedTask } })
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
  } else {
    if (!fields.target) return pending('task', '💬 どのタスクのことですか？')
    const edits = fields.edits ?? []
    if (!justifiedRemovals(edits, editText ?? original, originalAt)) return pending('mode', '🔔 どの通知を変更しますか？')
    const missing = nextEditQuestion(edits, true)
    if (missing) return missing.question === 'time' ? pending('time', '🔔 何時に通知しますか？') : pending('day', '🔔 いつ通知しますか？')
    const result = intentSchema.safeParse({ type: 'edit_notifications', target: fields.target, edits })
    return result.success ? { action: result.data } : pending('day', '🔔 いつ通知しますか？')
  }

  let { notice } = fields
  let change: NotificationChange | undefined
  if (notice) {
    if (notice.kind === 'absolute' && (!notice.date || !evidence.dates.includes(notice.date))) {
      return pending('day', '🔔 何日に通知しますか？')
    }
    if (notice.kind === 'relative' && notice.daysBefore === undefined) return pending('day', '🔔 何日前に通知しますか？')
    if (!notice.time && previous?.question === 'time' && answer.times.length === 1) {
      notice = { ...notice, time: answer.times[0] }
      fields.notice = notice
    }
    const { time, timeSource } = resolveNotificationClock({ dueDate: fields.dueDate!, anchor: now, groupRule,
      explicit: notice.time && evidence.times.includes(notice.time) ? notice.time : undefined,
      period: notificationPeriod(text, now) ?? notificationPeriod(original, originalAt) })
    notice = { ...notice, time }
    change = { resolvedTime: time, timeSource }
    if (notice.kind === 'absolute' && notice.date && absoluteTime({ date: notice.date, time }) <= now) {
      return { error: '🔔 指定した日時はすでに過ぎています。' }
    }
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
  return { action: checked, change }
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
  if (action.type === 'create_task' && !pending &&
    explicitNotificationDates(text, now).every(({ date }) => !date || date !== action.dueDate &&
      action.rule && absoluteReminders(action.rule).some((slot) => slot.date === date)) &&
    !/今週|来週|再来週|今月|来月|再来月|月末|年末|(?<!\d)\d{1,2}日(?!前|後|間|おき)/.test(text.normalize('NFKC')) &&
    action.dueDate >= todayInJapan(now)) {
    return { type: 'draft', operation: 'create_task', fields: { title: action.title, category: action.category, rule: action.rule } }
  }
  if (action.type === 'create_task' && !pending && !explicitNotificationTimes(text).length &&
    /(?:今夜|夜に)通知して/.test(text) && explicitNotificationDates(text, now).length === 1 && action.dueDate > todayInJapan(now)) {
    return { type: 'draft', operation: 'create_task', fields: { title: action.title, dueDate: action.dueDate, category: action.category,
      notice: { kind: 'absolute', date: todayInJapan(now) } } }
  }
  if (action.type !== 'edit_notifications') return
  const [edit] = action.edits
  const evidence = dateTimeEvidence(text, now)
  if (evidence.invalidDay || evidence.invalidTime) return
  if (action.edits.length === 1 && pending?.question === 'time' && pending.draft?.operation === 'create_task' &&
    pending.draft.fields.notice && action.target.by === 'recent' && evidence.times.length === 1 &&
    (edit.op === 'set_clock' || edit.op === 'add_clock') && edit.time === evidence.times[0]) {
    const notice = pending.draft.fields.notice
    const date = notice.kind === 'absolute' && evidence.dates.length === 1 ? evidence.dates[0] : undefined
    return { type: 'continue', fields: { notice: { ...notice, ...(date ? { date } : {}), time: edit.time } } }
  }
  if (!pending && action.edits.length === 1 && (edit.op === 'add' || edit.op === 'add_clock') && evidence.dates.length === 1 && !evidence.times.length) {
    return { type: 'draft', operation: 'edit_notifications', fields: { target: action.target,
      notice: { kind: 'absolute', date: evidence.dates[0] } } }
  }
  if (pending) return
  const vague = text.split(/[、。,\n]/).filter((clause) => /(?:朝|夜|夕方)(?:にも|に通知|の通知)/.test(clause) &&
    !explicitNotificationTimes(clause).length)
  const matches = (date: { kind: 'absolute'; date: string } | { kind: 'relative'; daysBefore: number }) => vague.some((clause) =>
    date.kind === 'absolute' ? explicitNotificationDates(clause, now).some((item) => item.date === date.date)
      : relativeDays(clause).includes(date.daysBefore))
  const edits = action.edits.map((item) => {
    if (item.op === 'add' && matches(item.when)) return { ...item, when: { ...item.when, time: undefined } }
    if (item.op === 'move' && item.to.kind !== 'time' && matches(item.to)) return { ...item, to: { ...item.to, time: undefined } }
    // When a model proposes moving the named day, check which clause actually asked for a change.
    if (item.op === 'move' && item.to.kind === 'time' && (item.selector.kind === 'absolute' || item.selector.kind === 'relative') &&
      matches(item.selector) && !vague.some((clause) => /変更|変え|ずら/.test(clause))) {
      return { op: 'add' as const, when: { ...item.selector, time: undefined } }
    }
    return item
  })
  if (edits.some((item, index) => item !== action.edits[index])) {
    return { type: 'draft', operation: 'edit_notifications', fields: { target: action.target, edits } }
  }
}
