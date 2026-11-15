import type { TaskAction } from '../src/tasks/intent'
import type { NotificationChange, NotificationEdit, NotificationSlot } from '../src/tasks/notification-plan'
import type { ReminderRule } from '../src/tasks/schedule'

export const evaluationNow = Date.parse('2026-11-15T10:00:00+09:00')
export const evaluationTask = { title: '英検申し込み', dueDate: '2026-12-14' }
const recent = { by: 'recent' } as const
const named = { by: 'name', name: '英検' } as const
const relative = (daysBefore: number, time?: string) => ({ kind: 'relative' as const, daysBefore, ...(time ? { time } : {}) })
const absolute = (date: string, time?: string) => ({ kind: 'absolute' as const, date, ...(time ? { time } : {}) })
const time = (value: string) => ({ kind: 'time' as const, time: value })
const focus = (daysBefore: number, value: string): NotificationChange => ({ after: { kind: 'relative', daysBefore, time: value } })
const first = focus(7, '20:00')
const chosen = focus(7, '08:00')
const nine = focus(7, '09:00')
const offsets = (...slots: [number, string][]): ReminderRule =>
  ({ type: 'offsets', slots: slots.map(([daysBefore, time]) => ({ daysBefore, time })) })
const mixed = offsets([7, '08:00'], [1, '20:00'])
const doubleEight = offsets([7, '08:00'], [1, '08:00'])
const nineOnly = offsets([7, '09:00'], [1, '09:00'])
const correctionRule: ReminderRule = offsets([7, '20:00'], [1, '20:00'], [0, '00:35'])
const repeat: ReminderRule = {
  type: 'repeat', startDaysBefore: 14, endDaysBefore: 1, everyDays: 7, weekdays: [], times: ['09:00'],
  extraSlots: [{ daysBefore: 1, time: '09:00' }],
}
const plan = (...edits: NotificationEdit[]): TaskAction => ({ type: 'edit_notifications', target: recent, edits })
const add = (when: ReturnType<typeof relative> | ReturnType<typeof absolute>) => ({ op: 'add', when } as const)
const remove = (selector: ReturnType<typeof relative> | ReturnType<typeof absolute> | ReturnType<typeof time> | { kind: 'recent' }) =>
  ({ op: 'remove', selector } as const)
const last = { kind: 'recent' } as const
const move = (selector: Parameters<typeof remove>[0], to: ReturnType<typeof time> | ReturnType<typeof relative> | ReturnType<typeof absolute>) =>
  ({ op: 'move', selector, to } as const)

export type IntentFixture = {
  text: string
  action: TaskAction
  quoted?: boolean
  rule?: ReminderRule
  focus?: NotificationChange
  enabled?: boolean
}

const relativeAdd = add(relative(14))
export const previousCases: IntentFixture[] = [
  { text: '英検申し込みの通知の方法について、2週間前にも通知して', action: { type: 'edit_notifications', target: named, edits: [relativeAdd] } },
  { text: '英検申し込み、2週間前にも教えて', action: { type: 'edit_notifications', target: named, edits: [relativeAdd] } },
  { text: 'さっきのやつ、14日前も', action: plan(relativeAdd) },
  { text: '2週間前にも', quoted: true, action: plan(relativeAdd) },
  { text: 'やっぱ前日だけでいいや', action: plan({ op: 'replace', rule: offsets([1, '20:00']) }) },
  { text: '7日前はいらない', action: plan(remove(relative(7))) },
  { text: '通知を21時にして', focus: first, action: plan(move(last, time('21:00'))) },
  { text: 'もうちょっと早めに通知して', action: { type: 'clarify', question: 'time' } },
  { text: 'これ終わった', action: { type: 'complete_task', target: recent } },
  { text: 'この申し込みは15日までにして', quoted: true, action: { type: 'update_task', target: recent, dueDate: '2026-12-15' } },
  { text: '通知もういらない', action: { type: 'disable_reminder', target: recent } },
  { text: '英検のやつっていつ通知される？', action: { type: 'get_reminder', target: named } },
]

const dates: [string, string, string][] = [
  ['11/16 0:35にも通知して', '2026-11-16', '00:35'],
  ['11月16日の午前0時35分にも教えて', '2026-11-16', '00:35'],
  ['明日の朝8時にも通知して', '2026-11-16', '08:00'],
  ['来週月曜の朝7時にも知らせて', '2026-11-16', '07:00'],
  ['2027/1/2 9:00にも通知して', '2027-01-02', '09:00'],
  ['1月2日9時にも通知して', '2027-01-02', '09:00'],
  ['11月30日の21時にも通知して', '2026-11-30', '21:00'],
  ['明後日の午後3時にも通知して', '2026-11-17', '15:00'],
  ['11/14 0:35にも通知して', '2026-11-14', '00:35'],
]
const weekdays = { startDaysBefore: 14, endDaysBefore: 1, everyDays: 7, weekdays: [] }
const removeAndAdd = plan(remove(relative(0, '00:35')), add(absolute('2026-11-16', '00:35')))
const removeThen = (daysBefore: number, time: string): NotificationChange => ({ before: { kind: 'relative', daysBefore, time } as NotificationSlot })

export const conversationCases: IntentFixture[] = [
  ...dates.map(([text, date, value]) => ({ text, action: plan(add(absolute(date, value))) })),
  { text: '11月31日の8時にも通知して', action: { type: 'clarify', question: 'day' } },
  { text: '2週間前くらいから毎週通知して', action: plan({ op: 'repeat', recurrence: weekdays }) },
  { text: '前日にも通知して', rule: repeat, action: plan(add(relative(1))) },
  { text: '8時じゃなくて9時に通知して', action: plan(move(time('08:00'), time('09:00'))) },
  { text: '8時じゃなくて9時でお願い', rule: mixed, action: plan(move(time('08:00'), time('09:00'))) },
  { text: '8時じゃなくて9時にして', rule: doubleEight, focus: chosen, action: plan(move(time('08:00'), time('09:00'))) },
  { text: '8時じゃなくて9時に変更して', rule: doubleEight, action: plan(move(time('08:00'), time('09:00'))) },
  { text: '3週間前にも通知して', rule: nineOnly, action: plan(add(relative(21))) },
  { text: '3週間前にも教えて', rule: mixed, action: plan(add(relative(21))) },
  { text: '21日前にも追加して', rule: offsets([7, '09:00'], [1, '20:00']), focus: nine, action: plan(add(relative(21))) },
  { text: '3週間前の9時にも通知して', rule: mixed, action: plan(add(relative(21, '09:00'))) },
  { text: '当日の0:35は消して、11月16日の0:35にして', rule: correctionRule, action: removeAndAdd },
  { text: '11/16の0:35に通知して、当日の0:35じゃなくて', rule: correctionRule, action: removeAndAdd },
  { text: '当日じゃなくて11月16日', rule: correctionRule, action: plan(move(relative(0), absolute('2026-11-16'))) },
  { text: '7日前は消して3日前にして', action: plan(remove(relative(7)), add(relative(3))) },
  { text: '前日の20時はそのままで、3日前の朝8時も追加して', action: plan(add(relative(3, '08:00'))) },
  { text: '14日前の9時を8時にして、前日の通知は消して', rule: offsets([14, '09:00'], [7, '20:00'], [1, '20:00']),
    action: plan(move(relative(14, '09:00'), time('08:00')), remove(relative(1))) },
  { text: '今の通知全部21時にして', action: plan({ op: 'set_clock', time: '21:00' }) },
  { text: 'すべての通知を19時に変更して', rule: mixed, action: plan({ op: 'set_clock', time: '19:00' }) },
  { text: 'その通知だけ消して', focus: first, action: plan(remove(last)) },
  { text: 'さっき追加した通知はいらない', focus: first, action: plan(remove(last)) },
  { text: 'いや、今のは消さないで', rule: offsets([1, '20:00']), focus: removeThen(7, '20:00'), action: plan({ op: 'undo_remove' }) },
  { text: 'それじゃなくて3日前', focus: first, action: plan(move(last, relative(3))) },
  { text: '追加したやつを1時間遅くして', focus: first, action: plan({ op: 'shift', selector: last, minutes: 60 }) },
  { text: 'さっきのやつ、やっぱ19時にして', focus: first, action: plan(move(last, time('19:00'))) },
  { text: '7日前だけを8時にして、3日前の9時も追加して', action: plan(move(relative(7), time('08:00')), add(relative(3, '09:00'))) },
  { text: '5日前の10時と3日前の9時にも通知して', action: plan(add(relative(5, '10:00')), add(relative(3, '09:00'))) },
  { text: '7日前と前日の通知を消して', action: plan(remove(relative(7)), remove(relative(1))) },
  { text: '前日の20時は消して、明日の8時と3日前の9時にも通知して', action: plan(remove(relative(1, '20:00')),
    add(absolute('2026-11-16', '08:00')), add(relative(3, '09:00'))) },
  { text: '2週間前の9時だけ消して', rule: repeat, action: plan(remove(relative(14, '09:00'))) },
  { text: '朝8時にも通知して', action: plan({ op: 'add_clock', time: '08:00' }) },
  { text: '通知を再開して', enabled: false, action: { type: 'enable_reminder', target: recent } },
  { text: '前日の通知も追加して、通知は止めて', rule: offsets([7, '20:00']), action: plan(add(relative(1)), { op: 'stop' }) },
]
