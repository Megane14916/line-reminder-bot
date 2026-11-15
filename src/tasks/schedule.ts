import { z } from 'zod'
import { todayInJapan } from './validation'

const day = 86_400_000
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
export const offset = z.number().int().min(0).max(366)
export const slotSchema = z.strictObject({ daysBefore: offset, time: timeSchema })
const slotsSchema = z.array(slotSchema).max(10)
export const ruleSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('default') }),
  z.strictObject({ type: z.literal('offsets'), slots: slotsSchema.min(1) }),
  z.strictObject({ type: z.literal('repeat'), startDaysBefore: offset.nullable(), endDaysBefore: offset,
    everyDays: z.number().int().min(1).max(366), weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    times: z.array(timeSchema).min(1).max(4), extraSlots: slotsSchema.optional(), excludedSlots: slotsSchema.optional() }),
]).refine((rule) => rule.type !== 'repeat' ||
  ((rule.startDaysBefore === null || rule.startDaysBefore >= rule.endDaysBefore) && (!rule.weekdays.length || rule.everyDays === 1)))

export type ReminderRule = z.infer<typeof ruleSchema>
export type ReminderSlot = z.infer<typeof slotSchema>
export const defaultRule: ReminderRule = { type: 'default' }

export function jstMidnight(date: string) {
  return Date.parse(`${date}T00:00:00+09:00`)
}

export function slotTime(due: number, { daysBefore, time }: ReminderSlot) {
  const [hours, minutes] = time.split(':').map(Number)
  return due - daysBefore * day + (hours * 60 + minutes) * 60_000
}

export function defaultReminderOffsets(dueDate: string, anchor: number) {
  const days = jstMidnight(dueDate) - jstMidnight(todayInJapan(anchor)) >= 8 * day ? [7, 1] : [1]
  return days.map((daysBefore) => ({ daysBefore, time: '20:00' }))
}

export function reminderSlots(rule: ReminderRule, dueDate: string, anchor: number, after: number, limit = 1): number[] {
  const due = jstMidnight(dueDate)
  const firstDay = jstMidnight(todayInJapan(anchor))
  if (rule.type !== 'repeat') {
    const slots = rule.type === 'default' ? defaultReminderOffsets(dueDate, anchor) : rule.slots
    return [...new Set(slots.map((slot) => slotTime(due, slot)))].sort((a, b) => a - b)
      .filter((time) => time > after).slice(0, limit)
  }

  const start = rule.startDaysBefore === null ? firstDay : due - rule.startDaysBefore * day
  const end = due - rule.endDaysBefore * day
  const step = rule.everyDays * day
  const earliest = Math.max(firstDay, jstMidnight(todayInJapan(after)))
  const times = [...new Set(rule.times)].sort()
  const excluded = new Set(rule.excludedSlots?.map((slot) => slotTime(due, slot)))
  const extras = rule.extraSlots?.map((slot) => slotTime(due, slot)).filter((at) => at > after) ?? []
  const result: number[] = []
  for (let date = start + Math.max(0, Math.ceil((earliest - start) / step)) * step; date <= end && result.length < limit; date += step) {
    const weekday = new Date(date + 9 * 3_600_000).getUTCDay()
    if (rule.weekdays.length && !rule.weekdays.includes(weekday)) continue
    for (const time of times) {
      const at = slotTime(date, { daysBefore: 0, time })
      if (at <= after || excluded.has(at)) continue
      result.push(at)
      if (result.length === limit) break
    }
  }
  return extras.length ? [...new Set([...result, ...extras])].sort((a, b) => a - b).slice(0, limit) : result
}

export function changeReminderTime(rule: ReminderRule, time: string, dueDate: string, anchor: number): ReminderRule {
  if (rule.type === 'repeat') {
    const days = new Set(rule.excludedSlots?.map(({ daysBefore }) => daysBefore))
    const excludedSlots = [...days].filter((daysBefore) => rule.times.every((previous) =>
      rule.excludedSlots?.some((slot) => slot.daysBefore === daysBefore && slot.time === previous)))
      .map((daysBefore) => ({ daysBefore, time }))
    const extraSlots = rule.extraSlots && [...new Set(rule.extraSlots.map(({ daysBefore }) => daysBefore))]
      .map((daysBefore) => ({ daysBefore, time }))
    return { ...rule, times: [time], ...(extraSlots ? { extraSlots } : {}),
      ...(rule.excludedSlots ? { excludedSlots } : {}) }
  }
  const slots = rule.type === 'offsets' ? rule.slots : defaultReminderOffsets(dueDate, anchor)
  return { type: 'offsets', slots: [...new Set(slots.map(({ daysBefore }) => daysBefore))]
    .map((daysBefore) => ({ daysBefore, time })) }
}
