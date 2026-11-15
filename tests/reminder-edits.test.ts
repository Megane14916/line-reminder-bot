import { expect, test } from 'vitest'
import { editReminder } from '../src/tasks/reminder-edits'
import { defaultRule, reminderSlots, type ReminderRule } from '../src/tasks/schedule'

const anchor = Date.parse('2030-11-25T10:00:00+09:00')
const dueDate = '2030-12-14'
const first = { daysBefore: 14, time: '20:00' }
const seven = { daysBefore: 7, time: '20:00' }
const eve = { daysBefore: 1, time: '20:00' }
const standard = { type: 'offsets', slots: [first, seven, eve] } satisfies ReminderRule

test('adds to the resolved default and recognizes a duplicate without editing', () => {
  expect(editReminder(defaultRule, { mode: 'add', slots: [first] }, dueDate, anchor, anchor))
    .toEqual({ kind: 'changed', rule: standard, anchor })
  expect(editReminder(standard, { mode: 'add', slots: [first] }, dueDate, anchor, anchor)).toEqual({ kind: 'duplicate' })
  expect(editReminder(defaultRule, { mode: 'add', slots: [eve] }, dueDate, anchor, anchor)).toEqual({ kind: 'duplicate' })
})

test('removes only the selected entry, asks when ambiguous and stops after the last entry', () => {
  expect(editReminder(standard, { mode: 'remove', slot: { daysBefore: 7 } }, dueDate, anchor, anchor))
    .toEqual({ kind: 'changed', rule: { type: 'offsets', slots: [first, eve] }, anchor })
  expect(editReminder(standard, { mode: 'remove', slot: { time: '20:00' } }, dueDate, anchor, anchor))
    .toEqual({ kind: 'ask_day' })
  const twoTimes = { type: 'offsets', slots: [eve, { ...eve, time: '08:00' }] } satisfies ReminderRule
  expect(editReminder(twoTimes, { mode: 'remove', slot: { daysBefore: 1 } }, dueDate, anchor, anchor))
    .toEqual({ kind: 'ask_time' })
  const one = { type: 'offsets', slots: [eve] } satisfies ReminderRule
  expect(editReminder(one, { mode: 'remove', slot: eve }, dueDate, anchor, anchor))
    .toEqual({ kind: 'changed', stopped: true, rule: one, anchor })
})

test('a time-only edit keeps the days and a time-only addition keeps the original times', () => {
  expect(editReminder(standard, { mode: 'change_time', time: '21:00' }, dueDate, anchor, anchor))
    .toEqual({ kind: 'changed', rule: { type: 'offsets', slots: [first, seven, eve].map((slot) => ({ ...slot, time: '21:00' })) }, anchor })
  expect(editReminder(defaultRule, { mode: 'add_time', time: '08:00' }, dueDate, anchor, anchor))
    .toEqual({ kind: 'changed', rule: { type: 'offsets', slots: [{ ...seven, time: '08:00' }, seven, { ...eve, time: '08:00' }, eve] }, anchor })
})

test('combines a recurring rule with extra notifications and removes a single occurrence', () => {
  const repeat = { type: 'repeat', startDaysBefore: 7, endDaysBefore: 1, everyDays: 2, weekdays: [], times: ['20:00'] } satisfies ReminderRule
  const added = editReminder(repeat, { mode: 'add', slots: [first, seven] }, dueDate, anchor, anchor)
  expect(added).toEqual({ kind: 'changed', rule: { ...repeat, extraSlots: [first] }, anchor })
  if (added.kind !== 'changed') throw new Error('Expected a merged rule')
  expect(reminderSlots(added.rule, dueDate, anchor, anchor, 10)).toEqual(
    ['11-30', '12-07', '12-09', '12-11', '12-13'].map((date) => Date.parse('2030-' + date + 'T20:00:00+09:00')))
  const removed = editReminder(added.rule, { mode: 'remove', slot: seven }, dueDate, anchor, anchor)
  expect(removed).toEqual({ kind: 'changed', rule: { ...repeat, extraSlots: [first], excludedSlots: [seven] }, anchor })
  if (removed.kind !== 'changed') throw new Error('Expected a rule with an exception')
  expect(reminderSlots(removed.rule, dueDate, anchor, Date.parse('2030-12-01T00:00:00+09:00'))[0])
    .toBe(Date.parse('2030-12-09T20:00:00+09:00'))
  const later = editReminder(removed.rule, { mode: 'change_time', time: '21:00' }, dueDate, anchor, anchor)
  expect(later).toEqual({ kind: 'changed',
    rule: { ...repeat, times: ['21:00'], extraSlots: [{ ...first, time: '21:00' }], excludedSlots: [{ ...seven, time: '21:00' }] }, anchor })
})
