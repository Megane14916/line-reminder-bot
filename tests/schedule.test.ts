import { expect, test } from 'vitest'
import { defaultRule, reminderSlots, ruleSchema } from '../src/tasks/schedule'

const at = (date: string, time = '20:00') => Date.parse(date + 'T' + time + ':00+09:00')
const due = '2030-12-20'
const now = at('2030-12-01')

test('selects default slots based on JST registration date and skips past slots', () => {
  expect(reminderSlots(defaultRule, due, now, now, 5)).toEqual([at('2030-12-13'), at('2030-12-19')])
  const week = at('2030-12-13', '00:00')
  expect(reminderSlots(defaultRule, due, week, week, 5)).toEqual([at('2030-12-19')])
  expect(reminderSlots(defaultRule, due, at('2030-12-19', '19:59'), at('2030-12-19', '19:59'))).toEqual([at('2030-12-19')])
  expect(reminderSlots(defaultRule, due, at('2030-12-19'), at('2030-12-19'))).toEqual([])
  expect(reminderSlots(defaultRule, '2031-01-01', at('2030-12-30'), at('2030-12-31', '00:00'))).toEqual([at('2030-12-31')])
})

test('computes daily windows, weekdays, multiple times and every other day', () => {
  const daily = { type: 'repeat', startDaysBefore: 7, endDaysBefore: 1, everyDays: 1, weekdays: [], times: ['20:00'] } as const
  const rule = ruleSchema.parse(daily)
  expect(reminderSlots(rule, due, now, now, 10)).toEqual(Array.from({ length: 7 }, (_, i) => at('2030-12-' + (13 + i))))
  const mondays = ruleSchema.parse({ ...daily, startDaysBefore: 14, weekdays: [1], times: ['08:00', '21:00'] })
  expect(reminderSlots(mondays, due, now, now, 10)).toEqual([
    at('2030-12-09', '08:00'), at('2030-12-09', '21:00'), at('2030-12-16', '08:00'), at('2030-12-16', '21:00'),
  ])
  const alternate = ruleSchema.parse({ ...daily, startDaysBefore: null, endDaysBefore: 0, everyDays: 2 })
  expect(reminderSlots(alternate, due, now, now, 2)).toEqual([at('2030-12-03'), at('2030-12-05')])
  expect(reminderSlots(alternate, '2080-12-20', now, at('2070-01-01')).length).toBe(1)
})
