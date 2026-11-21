import { expect, test } from 'vitest'
import { explicitNotificationDates, literalNotificationEdits, notificationActivation, simpleNotificationEdit, validateNotificationIntent } from '../src/tasks/notification-dates'
import { resolveNotificationClock } from '../src/tasks/notification-clock'
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

test('uses the current clock, a verified focus, group defaults or 20:00 when tied', () => {
  const add: NotificationEdit = { op: 'add', when: { kind: 'relative', daysBefore: 21 } }
  const original = offsets([{ daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '09:00' }])
  expect(applyNotificationPlan(state(original), [add])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '09:00'), timeSource: 'current' }],
  })
  const mixed = offsets([{ daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '20:00' }])
  expect(applyNotificationPlan(state(mixed), [add])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '20:00'), timeSource: 'default' }],
  })
  expect(applyNotificationPlan({ ...state(mixed), focusedClock: relative(7, '09:00') }, [add])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '09:00'), timeSource: 'conversation' }],
  })
  expect(applyNotificationPlan({ ...state(mixed), focusedClock: relative(7, '08:00') }, [add])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '20:00'), timeSource: 'default' }],
  })
  expect(applyNotificationPlan(state(mixed), [{ op: 'add', when: relative(21, '10:00') }])).toMatchObject({
    ok: true, changes: [{ after: relative(21, '10:00'), timeSource: 'explicit' }],
  })
  expect(applyNotificationPlan({ ...state(offsets([{ daysBefore: 7, time: '09:00' }])), defaultTime: '17:00' },
    [{ op: 'remove', selector: relative(7, '09:00') }, add])).toMatchObject({
    ok: true, changes: [{ before: relative(7, '09:00') }, { after: relative(21, '17:00'), timeSource: 'group' }],
  })
})

test('chooses a majority, resolves ties independent of ordering, and honors time bands and references', () => {
  const rule = offsets([{ daysBefore: 14, time: '09:00' }, { daysBefore: 7, time: '21:00' }, { daysBefore: 1, time: '21:00' }])
  const groupRule = offsets([{ daysBefore: 1, time: '18:30' }])
  const clocks = { dueDate, anchor: now, rule, groupRule }
  expect(resolveNotificationClock(clocks)).toEqual({ time: '21:00', timeSource: 'current' })
  expect(applyNotificationPlan({ ...state(rule), focus: { after: relative(14, '09:00') } },
    [{ op: 'add', when: { kind: 'relative', daysBefore: 3 } }])).toMatchObject({
    ok: true, changes: [{ after: relative(3, '21:00'), timeSource: 'current' }],
  })
  for (const slots of [[{ daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '21:00' }],
    [{ daysBefore: 1, time: '21:00' }, { daysBefore: 7, time: '09:00' }]]) {
    expect(resolveNotificationClock({ ...clocks, rule: offsets(slots) })).toEqual({ time: '18:30', timeSource: 'group' })
  }
  expect(resolveNotificationClock({ ...clocks, period: 'evening' })).toEqual({ time: '18:30', timeSource: 'group' })
  expect(resolveNotificationClock({ ...clocks, period: 'morning' })).toEqual({ time: '09:00', timeSource: 'current' })
  expect(resolveNotificationClock({ dueDate, anchor: now, period: 'morning' })).toEqual({ time: '08:00', timeSource: 'period' })
  expect(resolveNotificationClock({ ...clocks, original: '10:00', quotedAt: Date.parse('2026-11-20T22:00:00+09:00') }))
    .toEqual({ time: '10:00', timeSource: 'original' })
  expect(resolveNotificationClock({ ...clocks, period: 'night', quotedAt: Date.parse('2026-11-20T22:00:00+09:00') }))
    .toEqual({ time: '22:00', timeSource: 'quoted' })
  expect(resolveNotificationClock({ ...clocks, period: 'night', explicit: '08:00' })).toEqual({ time: '08:00', timeSource: 'explicit' })
})

test('removes all clocks on one recurring date or just the explicitly named clock', () => {
  const repeat: ReminderRule = { type: 'repeat', startDaysBefore: 7, endDaysBefore: 1, everyDays: 1, weekdays: [], times: ['08:00', '20:00'] }
  const remove = (time?: string) => applyNotificationPlan(state(repeat), [{ op: 'remove', selector: { kind: 'relative', daysBefore: 7, time } }])
  expect(remove()).toMatchObject({ ok: true, state: { rule: { times: repeat.times,
    excludedSlots: [{ daysBefore: 7, time: '08:00' }, { daysBefore: 7, time: '20:00' }] } },
    changes: [{ before: relative(7, '08:00') }, { before: relative(7, '20:00') }] })
  expect(remove('08:00')).toMatchObject({ ok: true, state: { rule: {
    excludedSlots: [{ daysBefore: 7, time: '08:00' }] } }, changes: [{ before: relative(7, '08:00') }] })
  const rule = remove()
  if (!rule.ok) throw new Error('Expected the day to be removed')
  expect(reminderSlots(rule.state.rule, dueDate, now, now, 2)).toEqual(
    ['2026-12-08T08:00:00+09:00', '2026-12-08T20:00:00+09:00'].map(Date.parse))
})

test.each([
  ['3日前にも通知して', { op: 'add', when: { kind: 'relative', daysBefore: 3 } }],
  ['3日前に通知して', { op: 'add', when: { kind: 'relative', daysBefore: 3 } }],
  ['前日だけ', { op: 'only', when: { kind: 'relative', daysBefore: 1 } }],
  ['7日前はいらない', { op: 'remove', selector: { kind: 'relative', daysBefore: 7 } }],
  ['前日の通知は外して', { op: 'remove', selector: { kind: 'relative', daysBefore: 1 } }],
  ['すべて9時に', { op: 'set_clock', time: '09:00' }],
  ['この通知だけ9時に', { op: 'move', selector: { kind: 'recent' }, to: { kind: 'time', time: '09:00' } }],
  ['明日の朝8時に通知して', { op: 'add', when: absolute('2026-11-16', '08:00') }],
])('grounds the default operation for %s', (text, edit) => {
  expect(simpleNotificationEdit(text, now)).toMatchObject(edit)
})

test('does not broaden explicitly limited removals to a whole day', () => {
  expect(simpleNotificationEdit('7日前の8時と9時の通知を消して', now)).toBeUndefined()
  expect(simpleNotificationEdit('7日前以外の通知を消して', now)).toBeUndefined()
  expect(validateNotificationIntent(make([{ op: 'remove', selector: { kind: 'relative', daysBefore: 7 } }]),
    '7日前以外の通知を消して', now)).toEqual({ type: 'clarify', question: 'day' })
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

test('grounding rejects dropped dates, swapped edits, and wrong clocks or scope', () => {
  const wrong = make([{ op: 'add', when: relative(0, '00:35') }])
  const exact = make([{ op: 'add', when: absolute('2026-11-16', '00:35') }])
  expect(validateNotificationIntent(wrong, '11/16 0:35にも通知して', now)).toEqual(exact)
  expect(validateNotificationIntent(exact, '11/16 0:35にも通知して', now)).toEqual(exact)
  expect(validateNotificationIntent(exact, '11/16 0:36にも通知して', now))
    .toEqual(make([{ op: 'add', when: absolute('2026-11-16', '00:36') }]))
  expect(validateNotificationIntent(make([{ op: 'set_clock', time: '09:00' }]), '8時じゃなくて9時に通知して', now))
    .toEqual(make([{ op: 'set_clock', time: '09:00' }]))
  expect(validateNotificationIntent(make([{ op: 'set_clock', time: '09:00' }]), '7日前の通知だけ9時にして', now))
    .toEqual(make([{ op: 'move', selector: { kind: 'relative', daysBefore: 7 }, to: { kind: 'time', time: '09:00' } }]))
  expect(validateNotificationIntent(make([{ op: 'remove', selector: absolute('2026-11-16', '00:35') },
    { op: 'add', when: relative(0, '00:35') }]), '当日の0:35は消して、11月16日の0:35にして', now))
    .toEqual({ type: 'clarify', question: 'day' })
  expect(validateNotificationIntent(make([{ op: 'add', when: relative(3, '08:00') },
    { op: 'add', when: relative(1, '20:00') }]), '前日の20時はそのままで、3日前の朝8時も追加して', now))
    .toEqual(make([{ op: 'add', when: relative(3, '08:00') }]))
  expect(validateNotificationIntent(make([{ op: 'add', when: relative(5, '09:00') },
    { op: 'add', when: relative(3, '10:00') }]), '5日前の10時と3日前の9時にも通知して', now))
    .toEqual({ type: 'clarify', question: 'time' })
  expect(validateNotificationIntent(make([{ op: 'move', selector: relative(7, '11:00'), to: { kind: 'time', time: '08:00' } },
    { op: 'add', when: relative(3, '09:00') }]), '7日前だけを8時にして、3日前の9時も追加して', now))
    .toEqual(make([{ op: 'move', selector: { kind: 'relative', daysBefore: 7 }, to: { kind: 'time', time: '08:00' } },
      { op: 'add', when: relative(3, '09:00') }]))
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

const mixedClocks = offsets([{ daysBefore: 14, time: '08:00' }, { daysBefore: 7, time: '20:00' }, { daysBefore: 1, time: '20:00' }])
test.each([
  ['8時じゃなくて9時に通知して', '09:00'],
  ['通知時間を9時にして', '09:00'],
  ['やっぱ朝7時で', '07:00'],
  ['20時じゃなくて21時でお願い', '21:00'],
  ['通知は全部19時にして', '19:00'],
])('%s changes all notification dates, independent of a recent focus', (text, time) => {
  const edits = literalNotificationEdits(text, now)
  expect(edits).toEqual([{ op: 'set_clock', time }])
  expect(applyNotificationPlan({ ...state(mixedClocks), focus: { after: relative(14, '08:00') } }, edits!))
    .toMatchObject({ ok: true, state: { rule: offsets([14, 7, 1].map((daysBefore) => ({ daysBefore, time }))) } })
})

test('specific scope uses a known occurrence or asks instead of using a different focus in a summary quote', () => {
  const text = 'この通知だけ9時にして'
  const edits = literalNotificationEdits(text, now)!
  const contextual = { ...state(mixedClocks), focus: { after: relative(14, '08:00') } }
  expect(edits).toEqual([{ op: 'move', selector: { kind: 'recent' }, to: { kind: 'time', time: '09:00' } }])
  expect(applyNotificationPlan({ ...contextual, quotedAt: Date.parse('2026-12-07T20:00:00+09:00') }, edits))
    .toMatchObject({ ok: true, changes: [{ before: relative(7, '20:00'), after: relative(7, '09:00') }] })
  expect(applyNotificationPlan({ ...contextual, quotedAt: null }, edits)).toMatchObject({ ok: false, reason: 'missing', destinationTime: '09:00' })
  expect(applyNotificationPlan(contextual, edits)).toMatchObject({ ok: true, changes: [{ after: relative(14, '09:00') }] })
  expect(applyNotificationPlan(contextual, literalNotificationEdits('この通知については、7時じゃなくて9時に通知して', now)!))
    .toMatchObject({ ok: false, reason: 'missing' })
})

test('matches and de-duplicates absolute dates by real delivery time while preserving the rule kind on a move', () => {
  const date = '2026-12-07'
  const selected = absolute(date, '20:00')
  const old = state(mixedClocks)
  expect(applyNotificationPlan(old, [{ op: 'add', when: selected }])).toMatchObject({ ok: true, state: { rule: mixedClocks }, changes: [] })
  expect(applyNotificationPlan(old, [{ op: 'remove', selector: selected }]))
    .toMatchObject({ ok: true, state: { rule: offsets([{ daysBefore: 14, time: '08:00' }, { daysBefore: 1, time: '20:00' }]) } })
  expect(applyNotificationPlan(old, literalNotificationEdits('12月7日の通知だけ9時にして', now)!))
    .toMatchObject({ ok: true, state: { rule: { slots: expect.arrayContaining([{ daysBefore: 7, time: '09:00' }]) } } })
  const colliding: ReminderRule = { ...mixedClocks as Extract<ReminderRule, { type: 'offsets' }>, absoluteSlots: [{ date, time: '20:00' }] }
  const moved = applyNotificationPlan(state(colliding), [{ op: 'move', selector: selected, to: { kind: 'time', time: '09:00' } }])
  expect(moved).toMatchObject({ ok: true, state: { rule: { absoluteSlots: [{ date, time: '09:00' }],
    slots: expect.arrayContaining([{ daysBefore: 7, time: '09:00' }]) } } })
  const removed = applyNotificationPlan(state(colliding), [{ op: 'remove', selector: selected }])
  expect(removed).toMatchObject({ ok: true, state: { rule: { absoluteSlots: [], slots: [
    { daysBefore: 14, time: '08:00' }, { daysBefore: 1, time: '20:00' },
  ] } } })
})

test('an absolute deletion on a recurring date excludes only that occurrence', () => {
  const weekly: ReminderRule = { type: 'repeat', startDaysBefore: 14, endDaysBefore: 7, everyDays: 7, weekdays: [], times: ['20:00'],
    absoluteSlots: [{ date: '2026-12-07', time: '20:00' }] }
  const result = applyNotificationPlan(state(weekly), [{ op: 'remove', selector: { kind: 'absolute', date: '2026-12-07' } }])
  expect(result).toMatchObject({ ok: true, state: { rule: { everyDays: 7, excludedSlots: [{ daysBefore: 7, time: '20:00' }], absoluteSlots: [] } } })
  if (!result.ok) throw new Error('Expected recurrence check')
  expect(reminderSlots(result.state.rule, dueDate, now, now, 10)).toEqual([Date.parse('2026-11-30T20:00:00+09:00')])
})

test('global retiming preserves dates, recurrence interval, weekdays, exclusions, and protected exceptions', () => {
  const weekly: ReminderRule = { type: 'repeat', startDaysBefore: 14, endDaysBefore: 1, everyDays: 1,
    weekdays: [1], times: ['08:00', '20:00'], extraSlots: [{ daysBefore: 1, time: '20:00' }],
    excludedSlots: [{ daysBefore: 7, time: '08:00' }, { daysBefore: 7, time: '20:00' }],
    absoluteSlots: [{ date: '2026-11-22', time: '08:00' }, { date: '2026-11-22', time: '20:00' }] }
  expect(applyNotificationPlan(state(weekly), [{ op: 'set_clock', time: '09:00' }])).toMatchObject({
    ok: true, state: { rule: { ...weekly, times: ['09:00'], excludedSlots: [{ daysBefore: 7, time: '09:00' }],
      absoluteSlots: [{ date: '2026-11-22', time: '09:00' }], extraSlots: [{ daysBefore: 1, time: '09:00' }] } },
  })
  const except = literalNotificationEdits('全部9時にして、前日の通知だけ20時のままにして', now)!
  expect(applyNotificationPlan(state(mixedClocks), except)).toMatchObject({ ok: true,
    state: { rule: offsets([{ daysBefore: 14, time: '09:00' }, { daysBefore: 7, time: '09:00' }, { daysBefore: 1, time: '20:00' }]) } })
  expect(applyNotificationPlan(state(mixedClocks), [{ op: 'remove', selector: { kind: 'relative', daysBefore: 7 } },
    { op: 'set_clock', time: '21:00' }])).toMatchObject({ ok: true, state: { rule: offsets([
    { daysBefore: 14, time: '21:00' }, { daysBefore: 1, time: '21:00' },
  ]) } })
})

test('activation follows a positive notification request and respects explicit setup-only directions', () => {
  const paused = { ...state(), enabled: false }
  const add: NotificationEdit = { op: 'add', when: { kind: 'relative', daysBefore: 3 } }
  expect(applyNotificationPlan({ ...paused, activation: notificationActivation('3日前にも通知して') }, [add]))
    .toMatchObject({ ok: true, state: { enabled: true } })
  expect(applyNotificationPlan({ ...paused, activation: notificationActivation('通知は止めたままで3日前も通知して') }, [add]))
    .toMatchObject({ ok: true, state: { enabled: false } })
  expect(applyNotificationPlan({ ...paused, activation: notificationActivation('設定だけ3日前を追加して') }, [add, { op: 'resume' }]))
    .toMatchObject({ ok: true, state: { enabled: false } })
  expect(applyNotificationPlan({ ...paused, activation: notificationActivation('前日だけ通知して') },
    [{ op: 'replace', rule: offsets([{ daysBefore: 1, time: '20:00' }]) }])).toMatchObject({ ok: true, state: { enabled: true } })
})
