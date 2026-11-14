import { expect, test } from 'vitest'
import { parseTaskInput } from '../src/tasks/validation'

const newYear = Date.parse('2030-12-31T15:00:00Z') // 2031-01-01 in Japan.

test.each([
  ['1/1 水筒', newYear, '2031-01-01', '水筒'],
  ['1/1 水筒', newYear - 1, '2031-01-01', '水筒'],
  ['2/29 遠足', newYear, '2032-02-29', '遠足'],
  ['2031-01-02   遠足の同意書  ', newYear, '2031-01-02', '遠足の同意書'],
  [`1/1 ${'😀'.repeat(100)}`, newYear, '2031-01-01', '😀'.repeat(100)],
])('parses %s against the JST calendar', (input, now, dueDate, title) => {
  expect(parseTaskInput(input, now)).toEqual({ title, dueDate })
})

test.each([
  '2030-12-31 過去の日付', '2031-02-29 存在しない日付', '2031-01-32 無効な日付',
  '13/1 無効な月', '4/31 無効な日', '1/1   ', '日付なし', `1/1 ${'a'.repeat(101)}`,
])('rejects %s', (input) => {
  expect(parseTaskInput(input, newYear)).toBeUndefined()
})
