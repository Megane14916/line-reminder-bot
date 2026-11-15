import type { TaskAction } from './intent'
import type { NotificationDate, NotificationEdit } from './notification-plan'
import { jstMidnight } from './schedule'
import { todayInJapan } from './validation'

const day = 86_400_000
const weekdays = '日月火水木金土'
const clockPattern = /(?:(午前|午後|朝|夜)\s*)?(\d{1,2})(?::(\d{2})|時(?:\s*(\d{1,2})分|(半))?)|朝(?=の通知|にも)|夜(?=の通知|にも)/g
function clocks(text: string) {
  return [...text.matchAll(clockPattern)].map((match) => {
    if (!match[2]) return { time: match[0] === '朝' ? '08:00' : '20:00', index: match.index, end: match.index + match[0].length }
    const period = match[1]
    let hour = Number(match[2])
    const minute = match[5] ? 30 : Number(match[3] ?? match[4] ?? 0)
    if (period === '午前' && hour === 12) hour = 0
    if ((period === '午後' || period === '夜') && hour < 12) hour += 12
    const time = hour < 24 && minute < 60 ? String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') : undefined
    return { time, index: match.index, end: match.index + match[0].length }
  })
}

const numericDate = /(?<!\d)(?:(\d{4})(?:年|[-/]))?(\d{1,2})(?:月|[-/])(\d{1,2})(?!\d)(?:日)?/g
const spokenDate = /(明後日|あさって|明日|あした|今日|きょう)|(?:(来週|今週|再来週)\s*)([日月火水木金土])曜(?:日)?/g
const relativeDate = /(?:(\d{1,3}|[一二三四五六七八九十百]{1,5})(日|週間)前)|(締切当日|当日|前日)/g
function relativeDays(text: string) {
  return [...text.matchAll(relativeDate)].map((match) => {
    if (match[3]) return Number(match[3] === '前日')
    let amount = Number(match[1])
    if (Number.isNaN(amount)) {
      const [, hundreds, tens, ones] = /^(?:([一二三四五六七八九]?百))?(?:([一二三四五六七八九]?十))?([一二三四五六七八九]?)$/.exec(match[1]) ?? []
      const digit = (value?: string) => value ? '一二三四五六七八九'.indexOf(value[0]) + 1 : 0
      amount = (hundreds ? (digit(hundreds) || 1) * 100 : 0) + (tens ? (digit(tens) || 1) * 10 : 0) + digit(ones)
    }
    return amount * (match[2] === '週間' ? 7 : 1)
  })
}

function relativeClockEvidence(text: string) {
  const available = clocks(text)
  return [...text.matchAll(relativeDate)].flatMap((part) => {
    const end = part.index + part[0].length
    const clock = available.find((entry) => entry.index >= end && /^[\sの]*$/.test(text.slice(end, entry.index)))
    return clock?.time ? [{ daysBefore: relativeDays(part[0])[0], time: clock.time }] : []
  })
}

export function explicitNotificationDates(text: string, now: number) {
  const normalized = text.normalize('NFKC')
  const today = todayInJapan(now)
  const [year, currentMonth] = today.split('-').map(Number)
  const midnight = jstMidnight(today)
  const clock = clocks(normalized)
  const dates: { date?: string; time?: string; index: number; end: number }[] = []
  for (const match of normalized.matchAll(numericDate)) {
    const month = Number(match[2]), dateOfMonth = Number(match[3])
    const resolvedYear = match[1] ? Number(match[1]) : year + Number(currentMonth >= 11 && month <= 2)
    const date = `${resolvedYear}-${String(month).padStart(2, '0')}-${String(dateOfMonth).padStart(2, '0')}`
    const at = jstMidnight(date)
    dates.push({ date: Number.isFinite(at) && todayInJapan(at) === date ? date : undefined,
      index: match.index, end: match.index + match[0].length })
  }
  for (const match of normalized.matchAll(spokenDate)) {
    const offset = match[1] ? /明後日|あさって/.test(match[1]) ? 2 : /明日|あした/.test(match[1]) ? 1 : 0
      : (match[2] === '再来週' ? 14 : match[2] === '来週' ? 7 : 0) + (weekdays.indexOf(match[3]) + 6) % 7
        - (new Date(midnight + 9 * 3_600_000).getUTCDay() + 6) % 7
    dates.push({ date: todayInJapan(midnight + offset * day), index: match.index, end: match.index + match[0].length })
  }
  return dates.sort((a, b) => a.index - b.index).map((date) => ({
    ...date,
    time: clock.find((time) => time.index >= date.end && /^[\sの、]*$/.test(normalized.slice(date.end, time.index)))?.time,
  }))
}

function preciseDate(text: string, now: number): NotificationDate | undefined {
  const input = text.trim().replace(/の$/, '')
  const times = clocks(input)
  const date = explicitNotificationDates(input, now)
  if (times.length > 1 || times.some((entry) => !entry.time)) return
  const hour = times[0]
  const end = hour?.end ?? input.length
  if (input.slice(end).trim()) return
  if (date.length === 1 && date[0].date && date[0].index === 0 &&
    /^[\sの]*$/.test(input.slice(date[0].end, hour?.index ?? end))) {
    return { kind: 'absolute', date: date[0].date, time: hour?.time }
  }
  const match = [...input.matchAll(relativeDate)]
  const relative = match[0]
  if (match.length === 1 && relative.index === 0 &&
    /^[\sの]*$/.test(input.slice(relative[0].length, hour?.index ?? end))) {
    const [daysBefore] = relativeDays(relative[0])
    if (daysBefore <= 366) return { kind: 'relative', daysBefore, time: hour?.time }
  }
}

// These whole-message forms carry their own evidence. No model-proposed date or target is applied here.
export function literalNotificationEdits(text: string, now: number): NotificationEdit[] | undefined {
  const input = text.normalize('NFKC').trim().replace(/[。！!]+$/, '')
  const weekly = /^(.+?)から毎週(?:通知して|知らせて)$/.exec(input)
  if (weekly) {
    const from = preciseDate(weekly[1].replace(/(?:くらい|ぐらい)$/, ''), now)
    if (from?.kind === 'relative' && from.daysBefore >= 1 && from.daysBefore <= 366) return [{
      op: 'repeat', recurrence: { startDaysBefore: from.daysBefore, endDaysBefore: 1, everyDays: 7, weekdays: [], time: from.time },
    }]
  }
  const corrected = /^(.+?)(?:に通知して|にして)、(.+?)(?:じゃなくて|ではなくて)$/.exec(input)
  if (corrected) {
    const destination = preciseDate(corrected[1], now)
    const previous = preciseDate(corrected[2], now)
    if (destination && previous) return [{ op: 'move', selector: previous, to: destination }]
  }
  const added = /^(.+?)(?:にも|も)(?:通知して|知らせて|教えて|追加して)$/.exec(input)
  if (added) {
    const when = preciseDate(added[1], now)
    if (when?.kind === 'absolute' && when.time) return [{ op: 'add', when }]
  }
  const correction = /^(?:それ|さっきの通知)(?:じゃなくて|ではなくて)(.+)$/.exec(input)
  if (correction) {
    const to = preciseDate(correction[1], now)
    if (to) return [{ op: 'move', selector: { kind: 'recent' }, to }]
  }
  const retime = /^(?:通知を|さっきのやつ、やっぱり?)(.+?)にして$/.exec(input)
  if (retime) {
    const [one, ...others] = clocks(retime[1])
    if (one?.time && !others.length && one.index === 0 && one.end === retime[1].length) {
      return [{ op: 'move', selector: { kind: 'recent' }, to: { kind: 'time', time: one.time } }]
    }
  }
}

function dateOperands(edit: NotificationEdit): NotificationDate[] {
  const result: NotificationDate[] = []
  if ('selector' in edit && (edit.selector.kind === 'absolute' || edit.selector.kind === 'relative')) result.push(edit.selector)
  if (edit.op === 'add') result.push(edit.when)
  if (edit.op === 'move' && edit.to.kind !== 'time') result.push(edit.to)
  if (edit.op === 'replace' && edit.rule.type !== 'default') {
    result.push(...(edit.rule.absoluteSlots ?? []).map((slot) => ({ kind: 'absolute' as const, ...slot })))
    if (edit.rule.type === 'offsets') result.push(...edit.rule.slots.map((slot) => ({ kind: 'relative' as const, ...slot })))
  }
  return result
}

export function validateNotificationIntent(action: TaskAction, text: string, now: number): TaskAction {
  const reminderOperation = action.type === 'edit_notifications' || action.type === 'modify_reminder' ||
    action.type === 'set_reminder' || action.type === 'disable_reminder' || action.type === 'enable_reminder'
  const normalized = text.normalize('NFKC')
  const parts = normalized.split(/[、。\n]/)
  const unchangedClauses = parts.flatMap((part) => /^(.+?)(?:そのままで?|残して)/.exec(part)?.[1] ?? []).join('、')
  const changedClauses = parts.map((part) => part.replace(/^.*?(?:そのままで?|残して)/, '')).join('、')
  const dates = explicitNotificationDates(changedClauses, now)
  if (action.type === 'create_task' && dates.length && /(?:にも|も追加).*(?:通知|知らせ|教え)|(?:通知|知らせ).*(?:じゃなく|ではなく)/.test(normalized)
    && !/タスクを登録|登録して|追加で登録/.test(normalized)) return { type: 'clarify', question: 'task' }
  if (!reminderOperation) return action
  const times = clocks(changedClauses)
  if (dates.some((date) => !date.date)) return { type: 'clarify', question: 'day' }
  if (times.some((time) => !time.time)) return { type: 'clarify', question: 'time' }
  const changePair = times.length >= 2 ? changedClauses.slice(times[0].end, times[1].index) : ''
  const all = /全部|すべて|全(?:て|通知|部)|一律/.test(normalized) &&
    !/(?:全部|すべて|全て|一律)(?:じゃなく|ではなく|は変更しない)/.test(normalized)
  if (action.type !== 'edit_notifications') {
    if (dates.length || /じゃなく|ではなく/.test(changePair)) return { type: 'clarify', question: dates.length ? 'day' : 'time' }
    if (action.type === 'disable_reminder' && !all && (times.length || relativeDays(changedClauses).length)) {
      return { type: 'clarify', question: 'day' }
    }
    const oldTime = action.type === 'modify_reminder' && action.edit.mode === 'change_time' ? action.edit.time
      : action.type === 'set_reminder' && action.setting.by === 'time' ? action.setting.time : undefined
    if (oldTime) {
      const time = times.at(-1)?.time
      if (oldTime !== time) return { type: 'clarify', question: 'time' }
      if (!all && 'target' in action) return { type: 'edit_notifications', target: action.target,
        edits: [{ op: 'move', selector: { kind: 'recent' }, to: { kind: 'time', time } }] }
    }
    if (action.type === 'modify_reminder' && action.edit.mode === 'add' && !times.length) return {
      type: 'edit_notifications', target: action.target,
      edits: action.edit.slots.map(({ daysBefore }) => ({ op: 'add', when: { kind: 'relative', daysBefore } })),
    }
    return action
  }

  const keepAbsolute = explicitNotificationDates(unchangedClauses, now)
  const keepRelative = relativeDays(unchangedClauses)
  const changedRelative = relativeDays(changedClauses)
  const statedRelativeTimes = relativeClockEvidence(changedClauses)
  const noStatedClock = (source: NotificationDate) => source.kind === 'relative'
    ? !statedRelativeTimes.some((clock) => clock.daysBefore === source.daysBefore)
    : !dates.some((date) => date.date === source.date && date.time)
  const edits = action.edits.filter((edit) => {
    if (edit.op !== 'add') return true
    const when = edit.when
    if (when.kind === 'absolute') return dates.some((date) => date.date === when.date) ||
      !keepAbsolute.some((date) => date.date === when.date && (!date.time || date.time === when.time))
    return changedRelative.includes(when.daysBefore) || !keepRelative.includes(when.daysBefore)
  }).map((edit): NotificationEdit => {
    if (!times.length && edit.op === 'add') return { ...edit, when: { ...edit.when, time: undefined } }
    if (!times.length && edit.op === 'repeat') return { ...edit, recurrence: { ...edit.recurrence, time: undefined } }
    if (edit.op === 'remove' && (edit.selector.kind === 'relative' || edit.selector.kind === 'absolute') && noStatedClock(edit.selector)) {
      return { ...edit, selector: { ...edit.selector, time: undefined } }
    }
    if (edit.op === 'move') {
      const source = edit.selector
      return { ...edit, selector: (source.kind === 'relative' || source.kind === 'absolute') && noStatedClock(source)
        ? { ...source, time: undefined } : source,
        to: !times.length && edit.to.kind !== 'time' ? { ...edit.to, time: undefined } : edit.to }
    }
    return edit
  })
  if (!edits.length) return { type: 'get_reminder', target: action.target }
  const clauses = changedClauses.replace(/(?:じゃなくて|ではなく|消して|削除して|なくして)(?=\s*[^、。\n])/g, '$&、').split('、')
  const globalStop = clauses.some((clause) => !relativeDays(clause).length && !clocks(clause).length &&
    !explicitNotificationDates(clause, now).length && /通知(?:を|は)?(?:止め|停止)/.test(clause))
  if (globalStop && !edits.some((edit) => edit.op === 'stop')) return { type: 'clarify', question: 'mode' }
  if (!globalStop && edits.some((edit) => edit.op === 'stop') && !/通知(?:を|は)?(?:全(?:部|て)?|もう)?いらない/.test(normalized)) {
    return { type: 'clarify', question: 'mode' }
  }
  if (edits.some((edit) => edit.op === 'set_clock' && !all)) return { type: 'clarify', question: 'day' }
  if (edits.some((edit) => edit.op === 'replace' &&
    !/(?:だけ|のみ)(?:でいい|にして|に変え|に変更|[。！!]*$)|リセット|全部変更|すべて変更|置き換え/.test(normalized))) {
    return { type: 'clarify', question: 'mode' }
  }
  if (!dates.length && times.length === 2 && /じゃなく(?:て)?|ではなく/.test(changePair) &&
    !edits.some((edit) => edit.op === 'move' && (relativeDays(changedClauses).length ? 'time' in edit.selector : edit.selector.kind === 'time') &&
      'time' in edit.selector && edit.selector.time === times[0].time &&
      edit.to.time === times[1].time)) return { type: 'clarify', question: 'time' }

  const operands = edits.flatMap(dateOperands)
  const absolute = operands.filter((when) => when.kind === 'absolute')
  if (absolute.some((when) => !dates.some((date) => date.date === when.date && (!date.time || date.time === when.time))) ||
    dates.some((date) => !absolute.some((when) => when.date === date.date && (!date.time || when.time === date.time)))) {
    return { type: 'clarify', question: 'day' }
  }
  const relevant = edits.some((edit) => edit.op === 'replace')
    ? changedClauses.split('、').filter((part) => !/いらない|消して|削除/.test(part) || /だけ/.test(part)).join('、') : changedClauses
  const editedDays = operands.filter((when) => when.kind === 'relative').map((when) => when.daysBefore)
  for (const edit of edits) if (edit.op === 'repeat') {
    if (edit.recurrence.startDaysBefore !== null) editedDays.push(edit.recurrence.startDaysBefore)
    editedDays.push(edit.recurrence.endDaysBefore)
  }
  const requestedDays = relativeDays(relevant)
  if (requestedDays.some((days) => !editedDays.includes(days))) return { type: 'clarify', question: 'day' }
  if (requestedDays.length && operands.some((when) => when.kind === 'relative' && !requestedDays.includes(when.daysBefore))) {
    return { type: 'clarify', question: 'day' }
  }
  if (!edits.some((edit) => edit.op === 'repeat')) {
    if (relativeClockEvidence(relevant).some((clock) => !operands.some((when) => when.kind === 'relative' &&
      when.daysBefore === clock.daysBefore && when.time === clock.time))) return { type: 'clarify', question: 'time' }
  }
  if (edits.some((edit) => edit.op === 'add' && edit.when.time && !times.some((clock) => edit.when.time === clock.time))) {
    return { type: 'clarify', question: 'time' }
  }

  if (!edits.some((edit) => edit.op === 'replace')) {
    const removals = edits.flatMap((edit) => edit.op === 'remove' || edit.op === 'move' ? [edit.selector] : [])
    const additions = edits.flatMap((edit) => edit.op === 'add' ? [edit.when] : edit.op === 'move' ? [edit.to] : [])
    for (const clause of clauses) {
      if (/毎週|毎日|日おき|曜日ごと/.test(clause) && edits.some((edit) => edit.op === 'repeat')) continue
      const operation = /消し|削除|いらない|なくし|じゃなく|ではなく/.test(clause) ? removals
        : /追加|(?:に)?も(?:通知|教え|知らせ)|通知して/.test(clause) && !/変更|変え|を.*に/.test(clause) ? additions : undefined
      if (!operation || /消さない/.test(clause)) continue
      if (relativeDays(clause).some((days) => !operation.some((when) => when.kind === 'relative' && when.daysBefore === days)) ||
        explicitNotificationDates(clause, now).some((date) =>
          !operation.some((when) => when.kind === 'absolute' && when.date === date.date))) return { type: 'clarify', question: 'day' }
    }
  }

  const editedTimes = operands.map((when) => when.time)
  for (const edit of edits) {
    if (edit.op === 'move') editedTimes.push(edit.to.time)
    if ('selector' in edit && edit.selector.kind === 'time') editedTimes.push(edit.selector.time)
    if (edit.op === 'set_clock' || edit.op === 'add_clock') editedTimes.push(edit.time)
    if (edit.op === 'repeat') editedTimes.push(edit.recurrence.time)
  }
  if (!edits.some((edit) => edit.op === 'shift') && clocks(changedClauses).some((clock) => !editedTimes.includes(clock.time))) {
    return { type: 'clarify', question: 'time' }
  }
  return { ...action, edits }
}
