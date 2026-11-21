import type { TaskAction } from './intent'
import type { NotificationDate, NotificationEdit } from './notification-plan'
import { jstMidnight } from './schedule'
import { todayInJapan } from './validation'
import type { Daypart } from './notification-clock'

const day = 86_400_000
const weekdays = '日月火水木金土'
const clockPattern = /(?:(午前|午後|朝|夜)\s*(?:の\s*)?)?(\d{1,2})(?::(\d{2})|時(?:\s*(\d{1,2})分|(半))?)/g
function clocks(text: string) {
  return [...text.matchAll(clockPattern)].map((match) => {
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
const spokenDate = /(明後日|あさって|明日|あした|今日|きょう|今朝|今夜)|(?:(来週|今週|再来週)\s*(?:の\s*)?)?([日月火水木金土])曜(?:日)?/g
const relativeDate = /(?:(\d{1,3}|[一二三四五六七八九十百]{1,5})(日|週間)前)|(締切当日|当日|前日)/g
export function relativeDays(text: string) {
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
  const clock = clocks(normalized).filter(({ index, end }) => /\d/.test(normalized.slice(index, end)))
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
    let offset = match[1] ? /明後日|あさって/.test(match[1]) ? 2 : /明日|あした/.test(match[1]) ? 1 : 0
      : (match[2] === '再来週' ? 14 : match[2] === '来週' ? 7 : 0) + (weekdays.indexOf(match[3]) + 6) % 7
        - (new Date(midnight + 9 * 3_600_000).getUTCDay() + 6) % 7
    if (!match[1] && !match[2] && offset < 0) offset += 7
    dates.push({ date: todayInJapan(midnight + offset * day), index: match.index, end: match.index + match[0].length })
  }
  return dates.sort((a, b) => a.index - b.index).map((date) => ({
    ...date,
    time: clock.find((time) => time.index === date.end - 1 && /今[朝夜]/.test(normalized.slice(date.index, date.end)) ||
      time.index >= date.end && /^[\sの、]*$/.test(normalized.slice(date.end, time.index)))?.time,
  }))
}

export function explicitNotificationTimes(text: string) {
  return clocks(text.normalize('NFKC')).map(({ time }) => time)
}

export function notificationPeriod(text: string, now: number, when?: NotificationDate): Daypart | undefined {
  const parts = text.normalize('NFKC').split(/[、,。\n]/).map((clause) => {
    const match = /(今朝|今夜|朝|夕方|夜)(?=に|にも|で|の通知|通知して|知らせて|ごろ|頃|$)/.exec(clause.trim())
    return { clause, period: !match ? undefined : /朝/.test(match[1]) ? 'morning' as const
      : match[1] === '夕方' ? 'evening' as const : 'night' as const }
  })
  const sameDay = when && parts.filter(({ clause }) => when.kind === 'relative'
    ? relativeDays(clause).includes(when.daysBefore) : explicitNotificationDates(clause, now).some(({ date }) => date === when.date))
  const exact = sameDay?.filter(({ period }) => period).at(-1)?.period
  if (exact) return exact
  return parts.filter(({ clause }) => !when || !relativeDays(clause).length && !explicitNotificationDates(clause, now).length)
    .filter(({ period }) => period).at(-1)?.period
}

export const removalWords = /消(?:し|して)|削除|いらない|外(?:し|して)|省(?:い|いて)|なくして|なし(?:で|に)|取り除/
export const keepNoticeWords = /消さない|外さない|省かない|削除しない|残して|そのまま/
const replacementWords = /だけ|のみ|置き換|入れ替え|リセット|今の設定をやめ/
export const clockReasonRequest = /(?:なんで|なぜ|どうして).*(?:時|通知)|(?:通知|時刻|時間).*(?:理由|どう決め)/
export const undoAdditionRequest = /^(?:やっぱり?\s*)?(?:今|さっき|直前)の(?:追加|通知を追加)(?:は|を)?(?:なし(?:で)?|取消して|取り消して|やめて)$/

export function simpleNotificationEdit(text: string, now: number): NotificationEdit | undefined {
  // Use the date and operation stated in one clause. Compound requests still require the whole plan.
  const value = text.normalize('NFKC').trim().replace(/[。！!]+$/, '')
  if (/[、。\n]|(?:(?:手順|例|場合)として)|(?:と言ったら|と仮定)/.test(value)) return
  if (undoAdditionRequest.test(value)) return { op: 'undo_add' }
  if (/^通知(?:は|を)(?:外して|なくして|やめて|なしで)$/.test(value)) return { op: 'stop' }
  const absolute = explicitNotificationDates(value, now)
  const relative = relativeDays(value)
  const times = explicitNotificationTimes(value)
  if (absolute.some(({ date }) => !date) || times.some((time) => !time) || relative.some((day) => day > 366)) return
  const when: NotificationDate | undefined = times.length <= 1 && absolute.length === 1 && !relative.length
    ? { kind: 'absolute', date: absolute[0].date!, time: absolute[0].time ?? (times.length === 1 ? times[0] : undefined) }
    : times.length <= 1 && relative.length === 1 && !absolute.length
      ? { kind: 'relative', daysBefore: relative[0], time: times[0] } : undefined
  if (removalWords.test(value) && !keepNoticeWords.test(value) && !/変更|変え|移し|以外|を除い/.test(value) &&
    (/通知/.test(value) || relative.length > 0 && !/タスク|期限|締切/.test(value))) {
    if (when) return { op: 'remove', selector: when }
    if (refersToIndividualNotification(value) && !absolute.length && !relative.length && times.length <= 1) {
      return { op: 'remove', selector: { kind: 'recent', time: times.length === 1 ? times[0] : undefined } }
    }
  }
  const clock = (!when || /(?:の通知|だけ).*(?:時|:\d{2})/.test(value) ||
    /(?:時|:\d{2})(?:に|へ)(?:変更|変え)/.test(value)) ? clockChange(value, now) : undefined
  if (clock) return clock
  if (when && replacementWords.test(value) && !/この通知|その通知|を(?:消|外)|以外|変え|変更|移し|通知だけ.*(?:時|:\d{2})/.test(value) &&
    /(?:通知|だけ(?:にして|でいい(?:や|よ)?|でお願い)?$|のみ(?:にして)?$)/.test(value)) return { op: 'only', when }
  if (when && /(?:日|朝|夕方|夜)(?:の\d{1,2}時)?\s*(?:に|へ)\s*(?:変更|変え|移し)/.test(value) && !/だけ|削除|消して|追加/.test(value)) {
    return { op: 'move', selector: { kind: 'recent' }, to: when }
  }
  if (absolute.length === 1 && relative.length === 1 && /(?:変更|変え|移し)/.test(value) && !/消し|削除|外し|追加/.test(value)) {
    const [source] = relativeClockEvidence(value)
    const [date] = absolute
    const relativeIndex = [...value.matchAll(relativeDate)][0].index
    if (relativeIndex < date.index) return { op: 'move', selector: { kind: 'relative', daysBefore: relative[0], time: source?.time },
      to: { kind: 'absolute', date: date.date!, time: date.time } }
  }
  if (when && /(?:通知(?:も|を)?(?:して|追加)|知らせて|追加して|増やして|教えて)$/.test(value) && !/毎|おき|曜日ごと|変更|変え|移し|削除|省い|外し|いらない|やめ|じゃなく|ではなく/.test(value)) {
    return { op: 'add', when }
  }
  if (!absolute.length && !relative.length && !times.length) {
    if (!allClock.test(value) && /(?:少し|ちょっと)早(?:め|く)に?(?:して|通知して)$/.test(value)) {
      return { op: 'shift', selector: { kind: 'recent' }, minutes: -30 }
    }
    if (notificationPeriod(value, now) && /(?:朝|夜|夕方)(?:に通知して|にして|でいい)$/.test(value)) return { op: 'period_clock' }
    if (/^(?:通知(?:を|は)?して|(?:.+?(?:の|は|を))通知して|いつもの時間で通知して)$/.test(value) && !/忘れない|毎|時刻/.test(value)) return { op: 'resume' }
  }
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

export function notificationDateQuery(text: string, now: number, allowTaskName = true) {
  const match = /([^、。\n]+?)(?:の|に|は)(?:通知(?:予定)?(?:は|が)?(?:ある|ありますか)|通知され(?:る|ますか)|通知(?:を|の)?確認(?:したい|して))\s*[？?。]*$/.exec(text.normalize('NFKC').trim())
  if (!match) return
  const dates = explicitNotificationDates(match[1], now)
  if (dates.length === 1) {
    const [date] = dates
    if (date.date && (allowTaskName || match.index + date.index === 0) && preciseDate(match[1].slice(date.index), now)) {
      return { kind: 'absolute' as const, date: date.date, time: date.time }
    }
  }
}

export function refersToQuotedNotification(text: string) {
  return /(?:この|その)通知/.test(text)
}

export function refersToRecentlyAdded(text: string) {
  return /(?:さっき|直前|今)(?:に)?追加した(?:通知|やつ)/.test(text)
}

function refersToIndividualNotification(text: string) {
  return refersToQuotedNotification(text) || refersToRecentlyAdded(text) || /さっきの通知/.test(text)
}

const holdNotification = /^(?:(?:通知は)?まだ通知しないで|(?:通知は)?まだ再開しないで)[。！!]*$/

export function notificationActivation(text: string): 'resume' | 'keep' | undefined {
  if (/設定だけ|(?:止めた|停止した)まま|停止中のまま|(?:通知|再開)(?:は|を)?(?:まだ)?しないで|まだ(?:通知|再開)しないで/.test(text)) return 'keep'
  if (/通知(?:を|も)?追加して|通知して|知らせて|教えて/.test(text) && !/いつ(?:通知|知らせ)|(?:通知|設定)(?:を|が|は)?(?:確認|教え)/.test(text)) return 'resume'
}

const explicitlyResumes = /(?:通知(?:を|は)?再開|(?:また|再び)通知して|再開して)/

const allClock = /全部|すべて|全(?:て|通知|部)|一律/
const negatedAll = /(?:全部|すべて|全て|一律)(?:じゃなく|ではなく|は変更しない)/
const clockCorrection = /^(?:じゃなくて?|ではなく(?:て)?|から)$/

function clockChange(text: string, now: number): Extract<NotificationEdit, { op: 'set_clock' | 'move' }> | undefined {
  const values = clocks(text)
  if (!values.length || values.length > 2 || values.some((value) => !value.time)) return
  const last = values.at(-1)!
  const time = last.time!
  const ending = text.slice(last.end).trim()
  if (!/^(?:に(?:通知して|して|変更して|変えて)|で(?:お願い(?:します)?)?|がいい(?:です)?)$/.test(ending) &&
    !(ending === 'に' && (allClock.test(text) || refersToIndividualNotification(text)))) return
  const previous = values.length === 2 ? values[0] : undefined
  const hasCorrection = previous && clockCorrection.test(text.slice(previous.end, last.index).trim())
  const before = text.slice(0, last.index).trim()
  const date = preciseDate(before.replace(/(?:の)?通知(?:の時間|の時刻)?(?:だけを?|を|は)?\s*$|(?:だけを?|を|は)\s*$/, ''), now)
  if (date) return { op: 'move', selector: date, to: { kind: 'time', time } }
  if (refersToIndividualNotification(before)) {
    const prefix = text.slice(0, hasCorrection ? previous.index : last.index).trim()
    if (/^(?:(?:この|その)通知|(?:さっき|直前|今)(?:に)?追加した(?:通知|やつ)|さっきの通知)(?:について)?(?:の(?:時間|時刻))?(?:は|を|だけ)?[、\s]*$/.test(prefix)
      && (!previous || hasCorrection)) return { op: 'move', selector: { kind: 'recent', ...(hasCorrection ? { time: previous.time } : {}) },
        to: { kind: 'time', time } }
    return
  }
  const prefix = text.slice(0, hasCorrection ? previous.index : last.index).trim()
  if ((!previous || hasCorrection) && /^(?:(?:さっきの(?:タスク|やつ)[の、]?)?\s*(?:やっぱり?|これからは?)?\s*(?:今の|(?:すべて|全て|全部)の)?(?:通知(?:の)?(?:時間|時刻)?(?:を|は)?)?\s*(?:全部|すべて|全て)?\s*)$/.test(prefix)) {
    return { op: 'set_clock', time }
  }
}

function clockExceptions(clauses: string[], now: number): NotificationDate[] {
  return clauses.flatMap((clause) => {
    const kept = /^(.+?)(?:そのまま|のまま|残して)(?:で|にして)?$/.exec(clause.trim())
    if (!kept) return []
    const selector = preciseDate(kept[1].replace(/(?:の)?通知(?:の)?(?:だけ|は|を)?|(?:だけ|は|を)\s*$/g, 'の'), now)
    return selector ? [selector] : []
  })
}

function removeDate(text: string, now: number): NotificationDate | undefined {
  const match = /^(.+?)(?:の通知)?(?:だけ)?(?:を|は)?(?:消して|削除して)$/.exec(text.trim())
  return match ? preciseDate(match[1], now) : undefined
}

function addDate(text: string, now: number): NotificationDate | undefined {
  const match = /^(.+?)(?:にも|も|を)(?:追加して|通知して)$/.exec(text.trim())
  return match ? preciseDate(match[1], now) : undefined
}

// These whole-message forms carry their own evidence. No model-proposed date or target is applied here.
export function literalNotificationEdits(text: string, now: number): NotificationEdit[] | undefined {
  const input = text.normalize('NFKC').trim().replace(/[。！!]+$/, '')
  const changed = clockChange(input, now)
  if (changed) return [changed]
  const [first, ...rest] = input.split(/[、,]/)
  if (rest.length && rest.length <= 8) {
    const firstClockChange = clockChange(first, now)
    const except = clockExceptions(rest, now)
    if (firstClockChange?.op === 'set_clock' && except.length === rest.length) return [{ ...firstClockChange, except }]
    if (firstClockChange?.op === 'move' && rest.length === 1) {
      const removed = removeDate(rest[0], now)
      if (removed) return [firstClockChange, { op: 'remove', selector: removed }]
      const added = addDate(rest[0], now)
      if (added) return [firstClockChange, { op: 'add', when: added }]
    }
    if (rest.length === 1 && clockExceptions([first], now).length) {
      const individual = clockChange(rest[0].trim(), now)
      if (individual?.op === 'move') return [individual]
      const addition = addDate(rest[0], now)
      if (addition) return [{ op: 'add', when: addition }]
    }
  }
  const removed = removeDate(first, now)
  if (removed && !rest.length && removed.kind === 'absolute') return [{ op: 'remove', selector: removed }]
  if (removed && rest.length === 1) {
    const remainder = rest[0].trim()
    const all = clockChange(remainder, now)
    if (all?.op === 'set_clock') return [{ op: 'remove', selector: removed }, all]
    const when = addDate(remainder, now)
    if (when) return [{ op: 'remove', selector: removed }, { op: 'add', when }]
  }
  if (holdNotification.test(input)) return [{ op: 'stop' }]
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
  const correctedDate = /^(.+?)(?:じゃなくて|ではなくて)(.+)$/.exec(input)
  if (correctedDate) {
    const selector = preciseDate(correctedDate[1], now)
    const to = preciseDate(correctedDate[2], now)
    if (selector && to && selector.kind !== to.kind) return [{ op: 'move', selector, to }]
  }
}

function dateOperands(edit: NotificationEdit): NotificationDate[] {
  const result: NotificationDate[] = []
  if ('selector' in edit && (edit.selector.kind === 'absolute' || edit.selector.kind === 'relative')) result.push(edit.selector)
  if (edit.op === 'add' || edit.op === 'only') result.push(edit.when)
  if (edit.op === 'move' && edit.to.kind !== 'time') result.push(edit.to)
  if (edit.op === 'replace' && edit.rule.type !== 'default') {
    result.push(...(edit.rule.absoluteSlots ?? []).map((slot) => ({ kind: 'absolute' as const, ...slot })))
    if (edit.rule.type === 'offsets') result.push(...edit.rule.slots.map((slot) => ({ kind: 'relative' as const, ...slot })))
  }
  return result
}

export function validateNotificationIntent(action: TaskAction, text: string, now: number, correctRecentNotice = false): TaskAction {
  const reminderOperation = action.type === 'edit_notifications' || action.type === 'modify_reminder' ||
    action.type === 'set_reminder' || action.type === 'disable_reminder' || action.type === 'enable_reminder'
  let normalized = text.normalize('NFKC')
  if (reminderOperation && 'target' in action && action.target.by === 'name' && action.target.dueDate) {
    const dueDate = action.target.dueDate
    for (const date of explicitNotificationDates(normalized, now).filter((entry) => entry.date === dueDate && !entry.time).reverse()) {
      const before = normalized.slice(0, date.index)
      const after = normalized.slice(date.end)
      const prefix = /(?:期限|締切)(?:が|は|の)\s*$/.exec(before)
      const suffix = /^(?:の|が)\s*(?:期限|締切)(?:の)?/.exec(after)
      if (prefix || suffix) normalized = (prefix ? before.slice(0, prefix.index) : before) + (suffix ? after.slice(suffix[0].length) : after)
    }
  }
  const parts = normalized.split(/[、。\n]/)
  const unchangedClauses = parts.flatMap((part) => /^(.+?)(?:そのままで?|のまま(?:にして)?|残して)/.exec(part)?.[1] ?? []).join('、')
  const changedClauses = parts.map((part) => part.replace(/^.*?(?:そのままで?|のまま(?:にして)?|残して)/, '')).join('、')
  const dates = explicitNotificationDates(changedClauses, now)
  if (action.type === 'create_task' && dates.length && /(?:にも|も追加).*(?:通知|知らせ|教え)|(?:通知|知らせ).*(?:じゃなく|ではなく)/.test(normalized)
    && !/タスクを登録|登録して|追加で登録/.test(normalized)) return { type: 'clarify', question: 'task' }
  if (!reminderOperation) return action
  if (/以外|を除い/.test(normalized) && removalWords.test(normalized) &&
    (action.type === 'disable_reminder' || action.type === 'edit_notifications' &&
      action.edits.some((edit) => edit.op === 'remove' || edit.op === 'stop'))) return { type: 'clarify', question: 'day' }
  if (/(?:通知設定|通知の設定)(?:を|が|は)?(?:確認したい|確認して|教えて)[。？?！!]*$/.test(normalized.trim()) && 'target' in action) {
    return { type: 'get_reminder', target: action.target }
  }
  if ('target' in action && !correctRecentNotice) {
    const simple = simpleNotificationEdit(normalized, now)
    const legacy = action.type === 'modify_reminder' && action.edit.mode === 'remove' && simple?.op === 'remove'
    if (simple && !legacy) return { type: 'edit_notifications', target: action.target, edits: [simple] }
    const literal = literalNotificationEdits(normalized, now)
    if (literal?.length === 1 && (literal[0].op === 'set_clock' || literal[0].op === 'move' && literal[0].to.kind === 'time')) {
      return { type: 'edit_notifications', target: action.target, edits: literal }
    }
  }
  const times = clocks(changedClauses)
  if (dates.some((date) => !date.date)) return { type: 'clarify', question: 'day' }
  if (times.some((time) => !time.time)) return { type: 'clarify', question: 'time' }
  const changePair = times.length >= 2 ? changedClauses.slice(times[0].end, times[1].index) : ''
  const referredNotice = refersToIndividualNotification(changedClauses) && !dates.length && !relativeDays(changedClauses).length
  const referredSource = { kind: 'recent' as const, ...(times.length === 2 && clockCorrection.test(changePair.trim())
    ? { time: times[0].time } : {}) }
  const individual = refersToIndividualNotification(changedClauses) || dates.length > 0 || relativeDays(changedClauses).length > 0
  const all = parts.some((part) => allClock.test(part) && !negatedAll.test(part) &&
    !refersToIndividualNotification(part) && clocks(part).length > 0)
  const wholeClock = !correctRecentNotice && (!individual && !negatedAll.test(normalized) || all)
  if (action.type !== 'edit_notifications') {
    if (dates.length) return { type: 'clarify', question: 'day' }
    if (action.type === 'disable_reminder' && !all && (times.length || relativeDays(changedClauses).length)) {
      return { type: 'clarify', question: 'day' }
    }
    const oldTime = action.type === 'modify_reminder' && action.edit.mode === 'change_time' ? action.edit.time
      : action.type === 'set_reminder' && action.setting.by === 'time' ? action.setting.time : undefined
    if (oldTime) {
      const time = times.at(-1)?.time
      if (oldTime !== time) return { type: 'clarify', question: 'time' }
      if (!wholeClock && relativeDays(changedClauses).length) return { type: 'clarify', question: 'day' }
      if ('target' in action) return { type: 'edit_notifications', target: action.target,
        edits: [wholeClock ? { op: 'set_clock', time }
          : { op: 'move', selector: referredSource, to: { kind: 'time', time } }] }
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
    if (!times.length && (edit.op === 'add' || edit.op === 'only')) return { ...edit, when: { ...edit.when, time: undefined } }
    if (!times.length && edit.op === 'repeat') return { ...edit, recurrence: { ...edit.recurrence, time: undefined } }
    if (edit.op === 'remove' && (edit.selector.kind === 'relative' || edit.selector.kind === 'absolute') && noStatedClock(edit.selector)) {
      return { ...edit, selector: { ...edit.selector, time: undefined } }
    }
    if (edit.op === 'move') {
      const source = edit.selector
      if (edit.to.kind === 'time' && wholeClock && (!individual || source.kind === 'recent' || source.kind === 'time')) {
        return { op: 'set_clock', time: edit.to.time }
      }
      if (edit.to.kind === 'time' && referredNotice && !wholeClock) return { ...edit, selector: referredSource }
      return { ...edit, selector: (source.kind === 'relative' || source.kind === 'absolute') && noStatedClock(source)
        ? { ...source, time: undefined } : source,
        to: edit.to.kind !== 'time' && !times.some((clock) => clock.time === edit.to.time) ? { ...edit.to, time: undefined } : edit.to }
    }
    if (edit.op === 'set_clock') {
      if (!wholeClock && referredNotice && times.at(-1)?.time === edit.time) {
        return { op: 'move', selector: referredSource, to: { kind: 'time', time: edit.time } }
      }
      const except = clockExceptions(parts, now)
      return { op: 'set_clock', time: edit.time, ...(except.length ? { except } : {}) }
    }
    return edit
  })
  if (!edits.length) return { type: 'get_reminder', target: action.target }
  if (edits.some((edit) => edit.op === 'set_clock' && !times.some((clock) => clock.time === edit.time) ||
    edit.op === 'move' && edit.to.kind === 'time' && !times.some((clock) => clock.time === edit.to.time))) {
    return { type: 'clarify', question: 'time' }
  }
  const duration = /(?:(\d{1,2})時間)?\s*(?:(\d{1,3})分)?\s*(?:ほど|くらい|だけ)?\s*(早|遅)/.exec(changedClauses)
  const minutes = duration && (Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0)) * (duration[3] === '早' ? -1 : 1)
  if (edits.some((edit) => edit.op === 'shift' && (!minutes || edit.minutes !== minutes))) {
    return { type: 'clarify', question: 'time' }
  }
  if (edits.some((edit) => edit.op === 'undo_add') && !undoAdditionRequest.test(normalized) ||
    edits.some((edit) => edit.op === 'period_clock') && !notificationPeriod(normalized, now)) return { type: 'clarify', question: 'mode' }
  if (edits.some((edit) => edit.op === 'resume') && !explicitlyResumes.test(normalized) && !notificationActivation(normalized)) {
    return { type: 'clarify', question: 'mode' }
  }
  const clauses = changedClauses.replace(/(?:じゃなくて|ではなく|消して|削除して|なくして)(?=\s*[^、。\n])/g, '$&、').split('、')
  const globalStop = clauses.some((clause) => !relativeDays(clause).length && !clocks(clause).length &&
    !explicitNotificationDates(clause, now).length && notificationActivation(clause) !== 'keep' &&
    /通知(?:を|は)?(?:止め|停止)/.test(clause))
  if (globalStop && !edits.some((edit) => edit.op === 'stop')) return { type: 'clarify', question: 'mode' }
  if (!globalStop && edits.some((edit) => edit.op === 'stop') && !holdNotification.test(normalized.trim()) &&
    !/通知(?:を|は)?(?:全(?:部|て)?|もう)?いらない/.test(normalized)) {
    return { type: 'clarify', question: 'mode' }
  }
  if (edits.some((edit) => edit.op === 'set_clock' && (!wholeClock ||
    /(?:そのまま|のまま|残して)/.test(normalized) && !edit.except?.length))) return { type: 'clarify', question: 'day' }
  if (edits.some((edit) => (edit.op === 'replace' || edit.op === 'only') &&
    !/(?:だけ|のみ)(?:でいい|にして|に変え|に変更|通知して|[。！!]*$)|リセット|全部変更|すべて変更|置き換え/.test(normalized))) {
    return { type: 'clarify', question: 'mode' }
  }
  if (!dates.length && times.length === 2 && /じゃなく(?:て)?|ではなく/.test(changePair) &&
    !edits.some((edit) => edit.op === 'set_clock' && edit.time === times[1].time) &&
    !edits.some((edit) => edit.op === 'move' && (relativeDays(changedClauses).length || refersToIndividualNotification(changedClauses) ||
      edit.selector.kind === 'time') &&
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
    const additions = edits.flatMap((edit) => edit.op === 'add' || edit.op === 'only' ? [edit.when] : edit.op === 'move' ? [edit.to] : [])
    for (const clause of clauses) {
      if (/毎週|毎日|日おき|曜日ごと/.test(clause) && edits.some((edit) => edit.op === 'repeat')) continue
      const operation = removalWords.test(clause) || /じゃなく|ではなく/.test(clause) ? removals
        : /追加|増や|(?:に)?も(?:通知|教え|知らせ)|通知して/.test(clause) && !/変更|変え|を.*に/.test(clause) ? additions : undefined
      if (!operation || keepNoticeWords.test(clause)) continue
      if (relativeDays(clause).some((days) => !operation.some((when) => when.kind === 'relative' && when.daysBefore === days)) ||
        explicitNotificationDates(clause, now).some((date) =>
          !operation.some((when) => when.kind === 'absolute' && when.date === date.date))) return { type: 'clarify', question: 'day' }
    }
  }

  const editedTimes = operands.map((when) => when.time)
  for (const edit of edits) {
    if (edit.op === 'move') editedTimes.push(edit.to.time)
    if ('selector' in edit && (edit.selector.kind === 'time' || edit.selector.kind === 'recent')) editedTimes.push(edit.selector.time)
    if (edit.op === 'set_clock' || edit.op === 'add_clock') editedTimes.push(edit.time)
    if (edit.op === 'repeat') editedTimes.push(edit.recurrence.time)
  }
  const requires = times.filter((clock, index) => !(edits.some((edit) => edit.op === 'set_clock') &&
    index + 1 < times.length && clockCorrection.test(changedClauses.slice(clock.end, times[index + 1].index).trim())))
  if (!edits.some((edit) => edit.op === 'shift') && requires.some((clock) => !editedTimes.includes(clock.time))) {
    return { type: 'clarify', question: 'time' }
  }
  return { ...action, edits }
}
