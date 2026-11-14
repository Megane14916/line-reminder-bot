import { z } from 'zod'
import { todayInJapan } from './validation'

const day = 86_400_000
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const offset = z.number().int().min(0).max(366)
export const ruleSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('default') }),
  z.strictObject({ type: z.literal('offsets'), slots: z.array(z.strictObject({ daysBefore: offset, time: timeSchema })).min(1).max(10) }),
  z.strictObject({ type: z.literal('repeat'), startDaysBefore: offset.nullable(), endDaysBefore: offset,
    everyDays: z.number().int().min(1).max(366), weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    times: z.array(timeSchema).min(1).max(4) }),
]).refine((rule) => rule.type !== 'repeat' ||
  ((rule.startDaysBefore === null || rule.startDaysBefore >= rule.endDaysBefore) && (!rule.weekdays.length || rule.everyDays === 1)))

export type ReminderRule = z.infer<typeof ruleSchema>
export const defaultRule: ReminderRule = { type: 'default' }

function jstMidnight(date: string) {
  return Date.parse(`${date}T00:00:00+09:00`)
}

export function reminderSlots(rule: ReminderRule, dueDate: string, anchor: number, after: number, limit = 1): number[] {
  const due = jstMidnight(dueDate)
  const firstDay = jstMidnight(todayInJapan(anchor))
  const asTime = (date: number, time: string) => {
    const [hours, minutes] = time.split(':').map(Number)
    return date + (hours * 60 + minutes) * 60_000
  }
  if (rule.type === 'default') {
    const days = due - firstDay >= 8 * day ? [7, 1] : [1]
    return days.map((n) => asTime(due - n * day, '20:00')).filter((time) => time > after).slice(0, limit)
  }
  if (rule.type === 'offsets') {
    return [...new Set(rule.slots.map(({ daysBefore, time }) => asTime(due - daysBefore * day, time)))].sort((a, b) => a - b)
      .filter((time) => time > after).slice(0, limit)
  }

  const start = rule.startDaysBefore === null ? firstDay : due - rule.startDaysBefore * day
  const end = due - rule.endDaysBefore * day
  const step = rule.everyDays * day
  const earliest = Math.max(firstDay, jstMidnight(todayInJapan(after)))
  const times = [...new Set(rule.times)].sort()
  const result: number[] = []
  for (let date = start + Math.max(0, Math.ceil((earliest - start) / step)) * step; date <= end; date += step) {
    const weekday = new Date(date + 9 * 3_600_000).getUTCDay()
    if (rule.weekdays.length && !rule.weekdays.includes(weekday)) continue
    for (const time of times) {
      const at = asTime(date, time)
      if (at <= after) continue
      result.push(at)
      if (result.length === limit) return result
    }
  }
  return result
}

export function changeReminderTime(rule: ReminderRule, time: string, dueDate: string, anchor: number): ReminderRule {
  if (rule.type === 'repeat') return { ...rule, times: [time] }
  const slots = rule.type === 'offsets' ? rule.slots
    : (jstMidnight(dueDate) - jstMidnight(todayInJapan(anchor)) >= 8 * day ? [7, 1] : [1]).map((daysBefore) => ({ daysBefore, time }))
  return { type: 'offsets', slots: slots.map((slot) => ({ ...slot, time })) }
}

export function describeSchedule(rule: ReminderRule, dueDate: string, anchor: number, now: number) {
  const slots = reminderSlots(rule, dueDate, anchor, now, 6)
  const format = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
  return slots.length ? `${slots.slice(0, 5).map(format).join('、')}${slots.length > 5 ? '、ほか' : ''}（JST）` : '今後の通知予定はありません。'
}
