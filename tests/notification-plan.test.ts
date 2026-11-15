import { expect, test } from 'vitest'
import { explicitNotificationDates, literalNotificationEdits, validateNotificationIntent } from '../src/tasks/notification-dates'
import { applyNotificationPlan, type NotificationEdit, type NotificationSlot } from '../src/tasks/notification-plan'
import { defaultRule, reminderSlots, type ReminderRule } from '../src/tasks/schedule'

const now = Date.parse('2026-11-15T10:00:00+09:00')
const dueDate = '2026-12-14'
const relative = (daysBefore: number, time: string): NotificationSlot => ({ kind: 'relative', daysBefore, time })
const absolute = (date: string, time: string): NotificationSlot => ({ kind: 'absolute', date, time })
const offsets = (slots: { daysBefore: number; time: string }[]): ReminderRule => ({ type: 'offsets', slots })
const make = (edits: NotificationEdit[]) => ({ type: 'edit_notifications', target: { by: 'recent' }, edits } as const)
const state = (rule: ReminderRule = defaultRule) => ({ rule, anchor: now, dueDate, now, enabled: true })

test.each([
  ['11/16 0:35', '2026-11-16', '00:35'],
  ['11月16日の午前0時35分', '2026-11-16', '00:35'],
  ['明日の朝8時', '2026-11-16', '08:00'],
  ['来週月曜の朝7時', '2026-11-16', '07:00'],
  ['2027/1/2 09:00', '2027-01-02', '09:00'],
  ['1月2日9時', '2027-01-02', '09:00'],
  ['11/14 0:35', '2026-11-14', '00:35'],
  ['11/31 0:35', undefined, '00:35'],
  ['2026-02-29 8時', undefined, '08:00'],
] as const)('resolves %s in Japan without moving past dates', (text, date, time) => {
  expect(explicitNotificationDates(text, now)).toMatchObject([{ date, time }])
})

test('uses the current clock, a verified focus, grouping defaults, or asks if mixed', () => {
  const add: NotificationEdit = { op: 'add', when: { kind: 'relative', daysBefore: 21 } }
  const original = offsets([{ daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '09:00' }])
  expect(applyNotificationPlan(state(original), [add])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '09:00'), timeSource: 'current' }],
  })
  const mixed = offsets([{ daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '20:00' }])
  expect(applyNotificationPlan(state(mixed), [add])).toMatchObject({ ok: false, reason: 'time' })
  expect(applyNotificationPlan({ ...state(mixed), focus: { after: relative(7, '09:00') } }, [add])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '09:00'), timeSource: 'conversation' }],
  })
  expect(applyNotificationPlan({ ...state(mixed), focus: { after: relative(7, '08:00') } }, [add])).toMatchObject({ ok: false, reason: 'time' })
  expect(applyNotificationPlan(state(mixed), [{ op: 'add', when: relative(21, '10:00') }])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '10:00'), timeSource: 'explicit' }],
  })
  expect(applyNotificationPlan({ ...state(offsets([{ daysBefore: 7, time: '09:00' }])), defaultTime: '17:00' },
    [{ op: 'remove', selector: relative(7, '09:00') }, add])).toMatchObject({
    ok: true, changes: [{ before: relative(7, '09:00') }, { after: relative(21, '17:00'), timeSource: 'group' }],
  })
})

test('changes one old time unless there is a matching recent target, or asks if ambiguous', () => {
  const move: NotificationEdit = { op: 'move', selector: { kind: 'time', time: '08:00' }, to: { kind: 'time', time: '09:00' } }
  expect(applyNotificationPlan(state(), [move])).toMatchObject({ ok: false, reason: 'missing' })
  const original = offsets([{ daysBefore: 7, time: '08:00' }, { daysBefore: 1, time: '08:00' }])
  expect(applyNotificationPlan(state(original), [move])).toMatchObject({ ok: false, reason: 'day' })
  expect(applyNotificationPlan({ ...state(original), focus: { after: relative(7, '08:00') } }, [move]))
    .toMatchObject({ ok: true, state: { rule: offsets([{ daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '08:00' }]) } })
  const repeat: ReminderRule = { type: 'repeat', startDaysBefore: 7, endDaysBefore: 1, everyDays: 1, weekdays: [], times: ['08:00'] }
  expect(applyNotificationPlan({ ...state(repeat), focus: { after: relative(1, '08:00') } }, [move])).toMatchObject({
    ok: true, changes: [{ before: relative(1, '08:00'), after: relative(1, '09:00') }],
  })
})

test('commits equivalent schedules only once and rejects a compound change when any item is invalid', () => {
  const original = offsets([{ daysBefore: 0, time: '00:35' }, { daysBefore: 7, time: '20:00' }])
  const remove: NotificationEdit = { op: 'remove', selector: relative(0, '00:35') }
  const add: NotificationEdit = { op: 'add', when: absolute('2026-11-16', '00:35') }
  const planned = applyNotificationPlan(state(original), [remove, add, add])
  expect(planned).toMatchObject({ ok: true, state: { rule: { type: 'offsets', slots: [{ daysBefore: 7, time: '20:00' }],
    absoluteSlots: [{ date: '2026-11-16', time: '00:35' }] } }, changes: [{ before: relative(0, '00:35') }, { after: add.when }] })
  if (!planned.ok) throw new Error('Expected a complete plan')
  expect(reminderSlots(planned.state.rule, '2026-12-15', now, now, 2)).toEqual(
    ['2026-11-16T00:35:00+09:00', '2026-12-08T20:00:00+09:00'].map(Date.parse))
  expect(applyNotificationPlan(state(original), [remove, { op: 'add', when: absolute('2026-11-14', '00:35') }]))
    .toMatchObject({ ok: false, reason: 'past' })
  expect(applyNotificationPlan(state(original), [add, { op: 'remove', selector: relative(14, '20:00') }]))
    .toMatchObject({ ok: false, reason: 'missing' })
  expect(state(original).rule).toEqual(original)
})

test('supports two removals, additions and edits to one recurring occurrence', () => {
  const repeat: ReminderRule = { type: 'repeat', startDaysBefore: 14, endDaysBefore: 1, everyDays: 7, weekdays: [],
    times: ['08:00'], extraSlots: [{ daysBefore: 1, time: '20:00' }] }
  const plan = applyNotificationPlan(state(repeat), [
    { op: 'move', selector: relative(14, '08:00'), to: { kind: 'time', time: '09:00' } },
    { op: 'remove', selector: relative(7, '08:00') }, { op: 'remove', selector: relative(1, '20:00') },
    { op: 'add', when: relative(4, '13:00') }, { op: 'add', when: absolute('2026-11-16', '00:35') },
  ])
  expect(plan).toMatchObject({ ok: true, state: { rule: { times: ['08:00'],
    excludedSlots: [{ daysBefore: 14, time: '08:00' }, { daysBefore: 7, time: '08:00' }],
    extraSlots: [{ daysBefore: 14, time: '09:00' }, { daysBefore: 4, time: '13:00' }] } } })
})

test('grounding rejects dropped dates, swapped edits, wrong clocks and non-explicit global changes', () => {
  const wrong = make([{ op: 'add', when: relative(0, '00:35') }])
  expect(validateNotificationIntent(wrong, '11/16 0:35にも通知して', now)).toEqual({ type: 'clarify', question: 'day' })
  const exact = make([{ op: 'add', when: absolute('2026-11-16', '00:35') }])
  expect(validateNotificationIntent(exact, '11/16 0:35にも通知して', now)).toEqual(exact)
  expect(validateNotificationIntent(exact, '11/16 0:36にも通知して', now)).toEqual({ type: 'clarify', question: 'day' })
  expect(validateNotificationIntent(make([{ op: 'set_clock', time: '09:00' }]), '8時じゃなくて9時に通知して', now))
    .toEqual({ type: 'clarify', question: 'day' })
  expect(validateNotificationIntent(make([{ op: 'remove', selector: absolute('2026-11-16', '00:35') },
    { op: 'add', when: relative(0, '00:35') }]), '当日の0:35は消して、11月16日の0:35にして', now))
    .toEqual({ type: 'clarify', question: 'day' })
  expect(validateNotificationIntent(make([{ op: 'add', when: relative(3, '08:00') },
    { op: 'add', when: relative(1, '20:00') }]), '前日の20時はそのままで、3日前の朝8時も追加して', now))
    .toEqual(make([{ op: 'add', when: relative(3, '08:00') }]))
  expect(validateNotificationIntent(make([{ op: 'add', when: relative(5, '09:00') },
    { op: 'add', when: relative(3, '10:00') }]), '5日前の10時と3日前の9時にも通知して', now))
    .toEqual({ type: 'clarify', question: 'time' })
})

test('recognizes complete literal corrections without guessing a time or a task', () => {
  expect(literalNotificationEdits('明日の朝8時にも通知して', now))
    .toEqual([{ op: 'add', when: absolute('2026-11-16', '08:00') }])
  expect(literalNotificationEdits('11/16の0:35に通知して、当日の0:35じゃなくて', now))
    .toEqual([{ op: 'move', selector: relative(0, '00:35'), to: absolute('2026-11-16', '00:35') }])
  expect(literalNotificationEdits('それじゃなくて3日前', now))
    .toEqual([{ op: 'move', selector: { kind: 'recent' }, to: { kind: 'relative', daysBefore: 3 } }])
  expect(literalNotificationEdits('11/16の0:35にも通知してと言ったら？', now)).toBeUndefined()
})

test('an absolute and relative occurrence can share a send while their dates follow different rules', () => {
  const rule: ReminderRule = { type: 'offsets', slots: [{ daysBefore: 1, time: '20:00' }],
    absoluteSlots: [{ date: '2026-12-13', time: '20:00' }] }
  expect(reminderSlots(rule, dueDate, now, now, 10)).toEqual([Date.parse('2026-12-13T20:00:00+09:00')])
  expect(reminderSlots(rule, '2026-12-15', now, now, 10)).toEqual(
    ['2026-12-13T20:00:00+09:00', '2026-12-14T20:00:00+09:00'].map(Date.parse))
})
