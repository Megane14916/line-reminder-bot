import { expect, test } from 'vitest'
import { formatReminderMessage, formatReminderSettings, formatTaskDate } from '../src/line/messages'
import { reminderSlots, type ReminderRule } from '../src/tasks/schedule'

const dueDate = '2026-12-20'
const now = Date.parse('2026-12-01T09:00:00+09:00')

function reminderSettings(rule: ReminderRule, options: { anchor?: number; at?: number; active?: boolean } = {}) {
  const { anchor = now, at = now, active = true } = options
  const next = active ? reminderSlots(rule, dueDate, anchor, at)[0] ?? null : null
  return formatReminderSettings('🔔 通知設定', 'レポート提出', { dueDate, rule, anchor, active, next }, at)
}

test('uses the Tokyo date and includes a year only when it differs from the current year in Tokyo', () => {
  const newYear = Date.parse('2026-12-31T15:00:00Z')
  expect(formatTaskDate(dueDate, now)).toBe('12月20日（日）')
  expect(formatTaskDate('2027-01-01', newYear - 1)).toBe('2027年1月1日（金）')
  expect(formatTaskDate('2027-01-01', newYear)).toBe('1月1日（金）')
})

test.each([
  ['2026-12-13T20:00:00+09:00', '締切まであと7日'],
  ['2026-12-19T20:00:00+09:00', '明日が締切です'],
  ['2026-12-19T23:00:00Z', '今日が締切です'],
])('formats a reminder at %s and keeps a legacy title on one line', (slot, countdown) => {
  expect(formatReminderMessage('レポート\n提出\u2028[第1回] 📝', dueDate, Date.parse(slot)))
    .toBe(`🔔 リマインダー\n\nレポート 提出 [第1回] 📝\n期限：12月20日（日）\n${countdown}`)
})

test('shows the default rule resolved at the same eight-day boundary as the scheduler', () => {
  const anchor = Date.parse('2026-12-12T21:00:00+09:00')
  expect(reminderSettings({ type: 'default' }, { anchor, at: anchor }))
    .toContain('通知：7日前・前日 20:00\n次回：12月13日（日）20:00')
  const later = Date.parse('2026-12-13T00:00:00+09:00')
  expect(reminderSettings({ type: 'default' }, { anchor: later, at: later }))
    .toContain('通知：前日 20:00\n次回：12月19日（土）20:00')
})

test('uses a chronological bulleted list for mixed times in offsets', () => {
  const rule: ReminderRule = { type: 'offsets', slots: [
    { daysBefore: 0, time: '08:00' }, { daysBefore: 3, time: '20:00' }, { daysBefore: 1, time: '20:00' },
  ] }
  expect(reminderSettings(rule)).toBe('🔔 通知設定\n\nレポート提出\n期限：12月20日（日）\n通知：\n・3日前 20:00\n・前日 20:00\n・当日 08:00\n次回：12月17日（木）20:00')
})

test.each([
  [1, [], ['20:00'], '毎日\n時刻：20:00\n次回：12月13日（日）20:00'],
  [2, [], ['20:00'], '2日おき\n時刻：20:00\n次回：12月13日（日）20:00'],
  [1, [1], ['20:00', '08:00'], '毎週月曜日\n時刻：\n・08:00\n・20:00\n次回：12月14日（月）08:00'],
] as const)('describes repeat rules with interval %s and weekdays %j', (everyDays, weekdays, times, expected) => {
  const rule: ReminderRule = { type: 'repeat', startDaysBefore: 7, endDaysBefore: 1, everyDays, weekdays: [...weekdays], times: [...times] }
  expect(reminderSettings(rule)).toContain(`通知：7日前から前日まで${expected}`)
})

test('distinguishes stopped notifications and enabled rules with no future occurrence', () => {
  const rule: ReminderRule = { type: 'offsets', slots: [{ daysBefore: 1, time: '20:00' }] }
  const passed = Date.parse('2026-12-19T21:00:00+09:00')
  expect(reminderSettings(rule, { active: false })).toMatch(/通知：停止中$/)
  expect(reminderSettings(rule, { at: passed })).toMatch(/通知：前日 20:00\n今後の通知予定はありません。$/)
})
