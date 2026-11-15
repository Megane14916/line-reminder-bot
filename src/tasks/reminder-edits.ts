import { z } from 'zod'
import { changeReminderTime, defaultReminderOffsets, jstMidnight, offset, reminderSlots, ruleSchema, slotSchema, slotTime,
  timeSchema, type ReminderRule, type ReminderSlot } from './schedule'
import { todayInJapan } from './validation'

const selector = z.strictObject({ daysBefore: offset.optional(), time: timeSchema.optional() })
  .refine(({ daysBefore, time }) => daysBefore !== undefined || time !== undefined)
export const reminderEditSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('add'), slots: z.array(slotSchema).min(1).max(10) }),
  z.strictObject({ mode: z.literal('add_time'), time: timeSchema }),
  z.strictObject({ mode: z.literal('remove'), slot: selector }),
  z.strictObject({ mode: z.literal('replace'), rule: ruleSchema }),
  z.strictObject({ mode: z.literal('change_time'), time: timeSchema }),
])

type Edit = z.infer<typeof reminderEditSchema>
type EditResult = { kind: 'changed'; rule: ReminderRule; anchor: number; stopped?: true } |
  { kind: 'duplicate' | 'missing' | 'limit' | 'ask_day' | 'ask_time' }

function sameSlot(a: ReminderSlot, b: ReminderSlot) {
  return a.daysBefore === b.daysBefore && a.time === b.time
}

function uniqueSlots(slots: ReminderSlot[]) {
  return [...new Map(slots.map((slot) => [slot.daysBefore + ':' + slot.time, slot])).values()]
    .sort((a, b) => b.daysBefore - a.daysBefore || a.time.localeCompare(b.time))
}

export function editReminder(rule: ReminderRule, edit: Edit, dueDate: string, anchor: number, now: number): EditResult {
  const changed = (next: ReminderRule): EditResult => ruleSchema.safeParse(next).success
    ? { kind: 'changed', rule: next, anchor } : { kind: 'limit' }
  if (edit.mode === 'replace') return { kind: 'changed', rule: edit.rule, anchor: now }
  if (edit.mode === 'change_time') return changed(changeReminderTime(rule, edit.time, dueDate, anchor))
  const stopped: EditResult = { kind: 'changed', rule, anchor, stopped: true }

  if (rule.type !== 'repeat') {
    const current = uniqueSlots(rule.type === 'offsets' ? rule.slots : defaultReminderOffsets(dueDate, anchor))
    if (edit.mode === 'remove') {
      const { daysBefore, time } = edit.slot
      const matches = current.filter((slot) => (daysBefore === undefined || slot.daysBefore === daysBefore)
        && (time === undefined || slot.time === time))
      if (!matches.length) return { kind: 'missing' }
      if (matches.length > 1) return { kind: daysBefore === undefined ? 'ask_day' : 'ask_time' }
      const slots = current.filter((slot) => !sameSlot(slot, matches[0]))
      return slots.length ? changed({ type: 'offsets', slots }) : stopped
    }
    const additions = edit.mode === 'add' ? edit.slots : current.map(({ daysBefore }) => ({ daysBefore, time: edit.time }))
    const slots = uniqueSlots([...current, ...additions])
    return slots.length === current.length ? { kind: 'duplicate' } : changed({ type: 'offsets', slots })
  }

  const extras = rule.extraSlots ?? []
  const excluded = rule.excludedSlots ?? []
  const includes = (candidate: ReminderRule, slot: ReminderSlot) => {
    const at = slotTime(jstMidnight(dueDate), slot)
    return reminderSlots(candidate, dueDate, anchor, at - 1)[0] === at
  }
  if (edit.mode === 'add') {
    const additions = edit.slots.filter((slot) => !includes(rule, slot))
    if (!additions.length) return { kind: 'duplicate' }
    return changed({ ...rule, extraSlots: uniqueSlots([...extras, ...additions]) })
  }
  if (edit.mode === 'add_time') {
    const extraSlots = uniqueSlots([...extras, ...extras.map(({ daysBefore }) => ({ daysBefore, time: edit.time }))])
    if (rule.times.includes(edit.time) && extraSlots.length === extras.length) return { kind: 'duplicate' }
    const fullyExcludedDays = [...new Set(excluded.map(({ daysBefore }) => daysBefore))].filter((daysBefore) =>
      rule.times.every((time) => excluded.some((slot) => sameSlot(slot, { daysBefore, time }))) &&
      !extras.some((slot) => slot.daysBefore === daysBefore))
    const excludedSlots = rule.times.includes(edit.time) ? excluded
      : uniqueSlots([...excluded, ...fullyExcludedDays.map((daysBefore) => ({ daysBefore, time: edit.time }))])
    return changed({ ...rule, times: [...new Set([...rule.times, edit.time])].sort(), extraSlots, excludedSlots })
  }

  const { daysBefore, time } = edit.slot
  const remaining = (next: ReminderRule) => {
    const first = Math.min(jstMidnight(todayInJapan(anchor)), jstMidnight(dueDate) - 366 * 86_400_000)
    return reminderSlots(next, dueDate, anchor, first - 1).length ? changed(next) : stopped
  }
  if (daysBefore === undefined) {
    const extraMatches = extras.filter((slot) => slot.time === time)
    const recurring = rule.times.some((value) => value === time)
    if (extraMatches.length + Number(recurring) > 1) return { kind: 'ask_day' }
    if (!recurring && !extraMatches.length) return { kind: 'missing' }
    const times = rule.times.filter((value) => value !== time)
    const extraSlots = extras.filter((slot) => slot.time !== time)
    if (!times.length) return extraSlots.length ? changed({ type: 'offsets', slots: extraSlots }) : stopped
    return remaining({ ...rule, times, extraSlots, excludedSlots: excluded.filter((slot) => slot.time !== time) })
  }
  const matches = uniqueSlots([...rule.times.map((value) => ({ daysBefore, time: value })), ...extras])
    .filter((slot) => slot.daysBefore === daysBefore && (time === undefined || time === slot.time) && includes(rule, slot))
  if (!matches.length) return { kind: 'missing' }
  if (matches.length > 1) return { kind: 'ask_time' }
  const [match] = matches
  const base = { ...rule, extraSlots: [] }
  return remaining({ ...rule, extraSlots: extras.filter((slot) => !sameSlot(slot, match)),
    excludedSlots: includes(base, match) ? uniqueSlots([...excluded, match]) : excluded })
}
