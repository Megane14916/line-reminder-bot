import { z } from 'zod'
import { editReminder } from './reminder-edits'
import { absoluteReminders, absoluteTime, changeReminderTime, defaultReminderOffsets, jstMidnight, offset,
  reminderSlots, ruleSchema, slotTime, timeSchema, type ReminderRule } from './schedule'
import { todayInJapan } from './validation'

const relative = z.strictObject({ kind: z.literal('relative'), daysBefore: offset, time: timeSchema.optional() })
const absolute = z.strictObject({ kind: z.literal('absolute'), date: z.iso.date(), time: timeSchema.optional() })
const clock = z.strictObject({ kind: z.literal('time'), time: timeSchema })
const dateSpec = z.discriminatedUnion('kind', [relative, absolute])
const selector = z.discriminatedUnion('kind', [relative, absolute, clock, z.strictObject({ kind: z.literal('recent') })])
const recurrence = z.strictObject({ startDaysBefore: offset.nullable(), endDaysBefore: offset, everyDays: z.number().int().min(1).max(366),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7), time: timeSchema.optional() })
export const notificationEditSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), when: dateSpec }),
  z.strictObject({ op: z.literal('add_clock'), time: timeSchema }),
  z.strictObject({ op: z.literal('remove'), selector }),
  z.strictObject({ op: z.literal('move'), selector, to: z.discriminatedUnion('kind', [relative, absolute, clock]) }),
  z.strictObject({ op: z.literal('shift'), selector, minutes: z.number().int().min(-1440).max(1440) }),
  z.strictObject({ op: z.literal('repeat'), recurrence }),
  z.strictObject({ op: z.literal('replace'), rule: ruleSchema }),
  z.strictObject({ op: z.literal('set_clock'), time: timeSchema }),
  z.strictObject({ op: z.literal('stop') }),
  z.strictObject({ op: z.literal('resume') }),
  z.strictObject({ op: z.literal('undo_remove') }),
])

export type NotificationEdit = z.infer<typeof notificationEditSchema>
export type NotificationDate = z.infer<typeof dateSpec>
export type NotificationSlot = NotificationDate & { time: string }
type Selector = z.infer<typeof selector>
export type TimeSource = 'explicit' | 'conversation' | 'current' | 'group' | 'default'
export type NotificationChange = { before?: NotificationSlot; after?: NotificationSlot; timeSource?: TimeSource; summary?: string; reactivate?: boolean }
type Problem = 'time' | 'day' | 'missing' | 'past' | 'limit' | 'conflict'
type State = { rule: ReminderRule; anchor: number; enabled: boolean }
type Input = State & { dueDate: string; now: number; focus?: NotificationChange; defaultTime?: string }
type Result = { ok: true; state: State; changes: NotificationChange[] } | { ok: false; reason: Problem; time?: string }
const day = 86_400_000
const japanClock = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function configuredTimes(rule: ReminderRule, dueDate: string, anchor: number) {
  const base = rule.type === 'default' ? defaultReminderOffsets(dueDate, anchor).map((s) => s.time)
    : rule.type === 'offsets' ? rule.slots.map((s) => s.time) : [...rule.times, ...(rule.extraSlots ?? []).map((s) => s.time)]
  return [...new Set([...base, ...absoluteReminders(rule).map((s) => s.time)])].sort()
}

export function scheduledTime(slot: NotificationSlot, dueDate: string) {
  return slot.kind === 'absolute' ? absoluteTime(slot) : slotTime(jstMidnight(dueDate), slot)
}

function sameDay(a: NotificationDate, b: NotificationDate) {
  return a.kind === 'relative' ? b.kind === 'relative' && a.daysBefore === b.daysBefore : b.kind === 'absolute' && a.date === b.date
}

function sameSlot(a: NotificationSlot, b: NotificationSlot) {
  return sameDay(a, b) && a.time === b.time
}

function occurrences(rule: ReminderRule, input: Input, wanted: Exclude<Selector, { kind: 'recent' }>) {
  const relativeSlots = rule.type === 'default' ? defaultReminderOffsets(input.dueDate, input.anchor)
    : rule.type === 'offsets' ? rule.slots : rule.extraSlots ?? []
  const candidates: NotificationSlot[] = [
    ...relativeSlots.map((s) => ({ kind: 'relative' as const, ...s })),
    ...absoluteReminders(rule).map((s) => ({ kind: 'absolute' as const, ...s })),
  ]
  if (rule.type === 'repeat' && wanted.kind !== 'absolute') {
    const times = wanted.time ? rule.times.filter((time) => time === wanted.time) : rule.times
    if (times.length) {
      const series = { ...rule, times, extraSlots: [], absoluteSlots: [] }
      const after = wanted.kind === 'relative' ? slotTime(jstMidnight(input.dueDate), { daysBefore: wanted.daysBefore, time: '00:00' }) - 1
        : input.now
      for (const at of reminderSlots(series, input.dueDate, input.anchor, after, 2 + candidates.length)) {
        const daysBefore = (jstMidnight(input.dueDate) - jstMidnight(todayInJapan(at))) / day
        candidates.push({ kind: 'relative', daysBefore, time: japanClock.format(at) })
      }
    }
  }
  return candidates.filter((candidate, index) =>
    (wanted.kind === 'time' || sameDay(candidate, wanted)) && (!wanted.time || candidate.time === wanted.time) &&
    candidates.findIndex((previous) => sameSlot(previous, candidate)) === index)
}

function withAbsolute(rule: ReminderRule, slots: ReturnType<typeof absoluteReminders>, input: Input): ReminderRule {
  if (rule.type === 'default') return { type: 'offsets', slots: defaultReminderOffsets(input.dueDate, input.anchor), absoluteSlots: slots }
  return { ...rule, absoluteSlots: slots }
}

function removeSlot(rule: ReminderRule, slot: NotificationSlot, input: Input): ReminderRule | undefined {
  if (slot.kind === 'absolute') return withAbsolute(rule, absoluteReminders(rule).filter((old) =>
    old.date !== slot.date || old.time !== slot.time), input)
  const result = editReminder(rule, { mode: 'remove', slot: { daysBefore: slot.daysBefore, time: slot.time } },
    input.dueDate, input.anchor, input.now)
  if (result.kind !== 'changed') return
  return result.stopped ? { type: 'offsets', slots: [], absoluteSlots: absoluteReminders(rule) } : result.rule
}

function addSlot(rule: ReminderRule, slot: NotificationSlot, input: Input): ReminderRule | undefined {
  if (slot.kind === 'absolute') return withAbsolute(rule, [...absoluteReminders(rule), { date: slot.date, time: slot.time }], input)
  const result = editReminder(rule, { mode: 'add', slots: [{ daysBefore: slot.daysBefore, time: slot.time }] },
    input.dueDate, input.anchor, input.now)
  return result.kind === 'changed' ? result.rule : result.kind === 'duplicate' ? rule : undefined
}

function pickTime(rule: ReminderRule, input: Input, explicit?: string): { time: string; timeSource: TimeSource } | undefined {
  if (explicit) return { time: explicit, timeSource: 'explicit' }
  const focused = input.focus?.after
  if (focused && occurrences(rule, input, focused).length === 1) return { time: focused.time, timeSource: 'conversation' }
  const times = configuredTimes(rule, input.dueDate, input.anchor)
  if (times.length > 1) return
  if (times.length === 1) return { time: times[0], timeSource: 'current' }
  return input.defaultTime ? { time: input.defaultTime, timeSource: 'group' } : { time: '20:00', timeSource: 'default' }
}

export function applyNotificationPlan(input: Input, edits: NotificationEdit[]): Result {
  let { rule, anchor, enabled } = input
  const changes: NotificationChange[] = []
  const reject = (reason: Problem, time?: string): Result => ({ ok: false, reason, time })
  for (const edit of edits) {
    const current = { ...input, anchor }
    if (edit.op === 'stop' || edit.op === 'resume') {
      const next = edit.op === 'resume'
      if (next !== enabled) changes.push({ summary: next ? '通知を再開' : '通知を停止' })
      enabled = next
      continue
    }
    if (edit.op === 'add_clock') {
      const relative = editReminder(rule, { mode: 'add_time', time: edit.time }, input.dueDate, anchor, input.now)
      if (relative.kind === 'limit') return reject('limit')
      const slots = absoluteReminders(rule)
      const added = [...new Set(slots.map((slot) => slot.date))]
        .filter((date) => !slots.some((slot) => slot.date === date && slot.time === edit.time))
        .map((date) => ({ date, time: edit.time }))
      if (added.some((slot) => absoluteTime(slot) <= input.now)) return reject('past')
      if (relative.kind === 'changed') rule = relative.rule
      if (added.length) rule = withAbsolute(rule, [...slots, ...added], current)
      if (relative.kind === 'changed' || added.length) changes.push({ summary: `通知日に${edit.time}を追加`, timeSource: 'explicit' })
      continue
    }
    if (edit.op === 'replace' || edit.op === 'set_clock' || edit.op === 'repeat') {
      if (edit.op === 'replace') {
        if (absoluteReminders(edit.rule).some((slot) => absoluteTime(slot) <= input.now)) return reject('past')
        rule = edit.rule
        anchor = input.now
        enabled = true
        changes.push({ summary: '通知ルールを置き換え' })
      } else if (edit.op === 'set_clock') {
        const next = changeReminderTime(rule, edit.time, input.dueDate, anchor)
        if (absoluteReminders(next).some((slot) => absoluteTime(slot) <= input.now &&
          !absoluteReminders(rule).some((old) => old.date === slot.date && old.time === slot.time))) return reject('past')
        rule = next
        changes.push({ summary: `すべての通知を${edit.time}に変更`, timeSource: 'explicit' })
      } else {
        const { time, ...period } = edit.recurrence
        const picked = pickTime(rule, current, time)
        if (!picked) return reject('time')
        const extraSlots = rule.type === 'default' ? defaultReminderOffsets(input.dueDate, anchor)
          : rule.type === 'offsets' ? rule.slots : rule.extraSlots
        const next = { type: 'repeat' as const, ...period, times: [picked.time], extraSlots,
          absoluteSlots: absoluteReminders(rule) }
        if (rule.type === 'repeat') {
          if (rule.startDaysBefore !== next.startDaysBefore || rule.endDaysBefore !== next.endDaysBefore ||
            rule.everyDays !== next.everyDays || JSON.stringify(rule.weekdays) !== JSON.stringify(next.weekdays) ||
            !rule.times.includes(picked.time)) return reject('conflict')
          continue
        }
        rule = next
        anchor = input.now
        changes.push({ summary: '繰り返しを追加', timeSource: picked.timeSource })
      }
      continue
    }

    let before: NotificationSlot | undefined
    if (edit.op !== 'add' && edit.op !== 'undo_remove') {
      const wanted = edit.selector.kind === 'recent' ? input.focus?.after : edit.selector
      const matches = wanted ? occurrences(rule, current, wanted) : []
      if (!matches.length) return reject('missing', wanted?.time)
      if (matches.length > 1) {
        const focused = input.focus?.after
        if (focused && wanted && (wanted.kind === 'time' || sameDay(focused, wanted)) &&
          (!wanted.time || focused.time === wanted.time) && occurrences(rule, current, focused).length === 1) before = focused
        if (!before) return reject(wanted?.kind === 'time' ? 'day' : 'time', wanted?.time)
      } else before = matches[0]
    }

    let destination: NotificationDate | undefined
    if (edit.op === 'add') destination = edit.when
    if (edit.op === 'move' && before) destination = edit.to.kind === 'time' ? { ...before, time: edit.to.time } : { ...edit.to, time: edit.to.time ?? before.time }
    if (edit.op === 'undo_remove') {
      destination = input.focus?.after ? undefined : input.focus?.before
      if (!destination) return reject('missing')
    }
    if (edit.op === 'shift' && before) {
      const at = scheduledTime(before, input.dueDate) + edit.minutes * 60_000
      const date = todayInJapan(at)
      const time = japanClock.format(at)
      const daysBefore = (jstMidnight(input.dueDate) - jstMidnight(date)) / day
      if (before.kind === 'relative' && (daysBefore < 0 || daysBefore > 366)) return reject('conflict')
      destination = before.kind === 'absolute' ? { kind: 'absolute', date, time } : { kind: 'relative', daysBefore, time }
    }

    const picked = edit.op === 'move' && !edit.to.time && before
      ? { time: before.time, timeSource: edit.selector.kind === 'recent' ? 'conversation' as const : 'current' as const }
      : edit.op === 'undo_remove' && destination?.time ? { time: destination.time, timeSource: 'conversation' as const }
        : destination ? pickTime(rule, current, destination.time) : undefined
    if (destination && !picked) return reject('time')
    const after = destination && picked ? { ...destination, time: picked.time } : undefined
    if (after && before && sameSlot(before, after)) continue
    if (after?.kind === 'absolute' && absoluteTime(after) <= input.now) return reject('past')
    const duplicate = after ? occurrences(rule, current, after).length > 0 : false
    if (!before && duplicate) {
      if (edit.op === 'undo_remove' && input.focus?.reactivate && !enabled) {
        enabled = true
        changes.push({ after, timeSource: picked?.timeSource })
      }
      continue
    }
    if (before) {
      const next = removeSlot(rule, before, current)
      if (!next) return reject('limit')
      rule = next
    }
    if (after && !duplicate) {
      const next = addSlot(rule, after, current)
      if (!next) return reject('limit')
      rule = next
    }
    changes.push({ before, after: duplicate ? undefined : after, timeSource: picked?.timeSource })
  }
  if (rule.type === 'offsets' && !rule.slots.length && !rule.absoluteSlots?.length) {
    rule = input.rule
    if (enabled && changes.length === 1) changes[0].reactivate = true
    enabled = false
  }
  if (!ruleSchema.safeParse(rule).success) return reject('limit')
  return { ok: true, state: { rule, anchor, enabled }, changes }
}
