import { absoluteReminders, defaultReminderOffsets, type ReminderRule } from './schedule'

export type Daypart = 'morning' | 'evening' | 'night'
export type TimeSource = 'explicit' | 'original' | 'quoted' | 'conversation' | 'current' | 'group' | 'period' | 'default'

const dayparts = {
  morning: { start: '05:00', end: '12:00', fallback: '08:00' },
  evening: { start: '16:00', end: '19:00', fallback: '18:00' },
  night: { start: '19:00', end: '24:00', fallback: '20:00' },
}
const japanClock = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function notificationClockAt(at: number) {
  return japanClock.format(at)
}

function configuredClocks(rule: ReminderRule | undefined, dueDate: string, anchor: number) {
  if (!rule) return []
  const base = rule.type === 'default' ? defaultReminderOffsets(dueDate, anchor).map((slot) => slot.time)
    : rule.type === 'offsets' ? rule.slots.map((slot) => slot.time) : [...rule.times, ...(rule.extraSlots ?? []).map((slot) => slot.time)]
  return [...base, ...absoluteReminders(rule).map((slot) => slot.time)]
}

function mostCommon(times: string[]) {
  const counts = new Map<string, number>()
  for (const time of times) counts.set(time, (counts.get(time) ?? 0) + 1)
  const highest = Math.max(0, ...counts.values())
  const winners = [...counts].filter(([, count]) => count === highest)
  return winners.length === 1 ? winners[0][0] : undefined
}

export function resolveNotificationClock(input: {
  dueDate: string; anchor: number; rule?: ReminderRule; groupRule?: ReminderRule; defaultTime?: string
  explicit?: string; original?: string; quotedAt?: number | null; focused?: string; period?: Daypart
}): { time: string; timeSource: TimeSource } {
  const band = input.period ? dayparts[input.period] : undefined
  const fits = (time: string) => !band || time >= band.start && time < band.end
  const quoted = input.quotedAt == null ? undefined : notificationClockAt(input.quotedAt)
  const references: [string | undefined, TimeSource][] = [
    [input.original, 'original'], [quoted, 'quoted'], [input.focused, 'conversation'],
  ]
  if (input.explicit) return { time: input.explicit, timeSource: 'explicit' }
  for (const [time, timeSource] of references) if (time && fits(time)) return { time, timeSource }
  const current = mostCommon(configuredClocks(input.rule, input.dueDate, input.anchor).filter(fits))
  if (current) return { time: current, timeSource: 'current' }
  const group = mostCommon(configuredClocks(input.groupRule, input.dueDate, input.anchor).filter(fits)) ??
    (input.defaultTime && fits(input.defaultTime) ? input.defaultTime : undefined)
  if (group) return { time: group, timeSource: 'group' }
  return band ? { time: band.fallback, timeSource: 'period' } : { time: '20:00', timeSource: 'default' }
}
