import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery, type PlatformProxy } from 'wrangler'
import initialMigration from '../migrations/0001_init.sql?raw'
import reminderMigration from '../migrations/0002_notification_batches.sql?raw'
import worker from '../src/index'

const scheduledTime = Date.parse('2030-12-31T11:00:00Z')
const nextDay = '2031-01-01'
let platform: PlatformProxy<Env>

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ persist: false, remoteBindings: false, envFiles: [] })
  const { DB } = platform.env
  for (const migration of [initialMigration, reminderMigration]) {
    await DB.batch(unstable_splitSqlQuery(migration).map((sql) => DB.prepare(sql)))
  }
}, 20_000)

afterAll(async () => await platform?.dispose())

beforeEach(async () => {
  const { DB } = platform.env
  await DB.batch([DB.prepare('DELETE FROM tasks'), DB.prepare('DELETE FROM notification_batches')])
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function runCron(time = scheduledTime) {
  return worker.scheduled({ scheduledTime: time, cron: '0 11 * * *', noRetry: vi.fn() }, {
    ...platform.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
  })
}

function addTask(groupId: string, title: string, {
  dueDate = nextDay, category = 'deadline', status = 'open', createdAt = scheduledTime - 1,
} = {}) {
  return platform.env.DB.prepare(`
    INSERT INTO tasks (group_id, category, title, due_date, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'user', ?)
  `).bind(groupId, category, title, dueDate, status, createdAt)
}

function batches() {
  return platform.env.DB.prepare('SELECT * FROM notification_batches ORDER BY group_id, target_due_date').all()
}

test('sends nothing when no open task is due on the target date', async () => {
  await platform.env.DB.batch([
    addTask('group-a', '提出済み', { status: 'done' }),
    addTask('group-b', '別の日', { dueDate: '2031-01-02' }),
  ])
  await runCron()
  expect(fetch).not.toHaveBeenCalled()
  expect((await batches()).results).toEqual([])
})

test('groups the next JST date across the year boundary and skips late and completed tasks', async () => {
  await platform.env.DB.batch([
    addTask('group-a', '遠足の同意書'),
    addTask('group-a', '水筒', { category: 'belonging', createdAt: scheduledTime }),
    addTask('group-a', '登録が遅い', { createdAt: scheduledTime + 1 }),
    addTask('group-a', '提出済み', { status: 'done' }),
    addTask('group-b', '申込書'),
  ])
  const mock = vi.mocked(fetch)
  mock.mockImplementation(async (_url, request) => {
    const body = JSON.parse(String(request?.body))
    const key = new Headers(request?.headers).get('X-Line-Retry-Key')
    const row = await platform.env.DB.prepare('SELECT * FROM notification_batches WHERE group_id = ?')
      .bind(body.to).first()
    expect(row).toMatchObject({ status: 'pending', message_text: body.messages[0].text, retry_key: key })
    return new Response(null, { status: 200 })
  })

  await runCron()

  expect(mock).toHaveBeenCalledTimes(2)
  const [first, second] = mock.mock.calls
  expect(first[0]).toBe('https://api.line.me/v2/bot/message/push')
  expect(first[1]?.method).toBe('POST')
  expect(new Headers(first[1]?.headers).get('Authorization')).toBe('Bearer test-access-token')
  expect(JSON.parse(String(first[1]?.body))).toEqual({
    to: 'group-a', messages: [{ type: 'text', text: '明日（2031-01-01）が期限のタスク（2件）\n・［期限］遠足の同意書\n・［持ち物］水筒' }],
  })
  expect(JSON.parse(String(second[1]?.body))).toMatchObject({
    to: 'group-b', messages: [{ type: 'text', text: expect.stringContaining('申込書') }],
  })
  const { results } = await batches()
  expect(results).toMatchObject([
    { group_id: 'group-a', target_due_date: nextDay, status: 'sent', sent_at: expect.any(Number) },
    { group_id: 'group-b', target_due_date: nextDay, status: 'sent', sent_at: expect.any(Number) },
  ])
  expect(results[0].retry_key).not.toBe(results[1].retry_key)
})

test('uses the JST calendar date when a scheduled time falls near midnight', async () => {
  const japanNewYear = Date.parse('2030-12-31T15:00:00Z')
  await platform.env.DB.batch([
    addTask('group-a', '元日'),
    addTask('group-a', '翌日', { dueDate: '2031-01-02' }),
  ])
  await runCron(japanNewYear - 1)
  await runCron(japanNewYear)
  expect((await batches()).results).toMatchObject([
    { target_due_date: nextDay, message_text: expect.stringContaining('元日') },
    { target_due_date: '2031-01-02', message_text: expect.stringContaining('翌日') },
  ])
})

test('keeps a single send across overlapping and repeated triggers', async () => {
  await addTask('group-a', '水筒').run()
  await Promise.all([runCron(), runCron(), runCron()])
  await runCron()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await batches()).results).toMatchObject([{ status: 'sent' }])
})

test('leaves an existing pending batch and its payload untouched', async () => {
  await addTask('group-a', '水筒').run()
  await platform.env.DB.prepare(`
    INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, created_at)
    VALUES ('group-a', ?, '保存した本文', 'original-key', ?)
  `).bind(nextDay, scheduledTime).run()
  await runCron()
  expect(fetch).not.toHaveBeenCalled()
  expect((await batches()).results).toMatchObject([
    { status: 'pending', message_text: '保存した本文', retry_key: 'original-key' },
  ])
})

test('records a LINE response confirming that the retry key was already accepted', async () => {
  await addTask('group-a', '水筒').run()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, {
    status: 409, headers: { 'X-Line-Accepted-Request-Id': 'test-request-id' },
  }))
  await runCron()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await batches()).results).toMatchObject([{ status: 'sent', sent_at: expect.any(Number) }])
})

test('records HTTP and network errors and continues to the next group without retrying', async () => {
  await platform.env.DB.batch(['group-a', 'group-b', 'group-c'].map((group) => addTask(group, '水筒')))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockRejectedValueOnce(new Error('network error'))
  await runCron()
  await runCron()
  expect(fetch).toHaveBeenCalledTimes(3)
  expect((await batches()).results).toMatchObject([
    { group_id: 'group-a', status: 'failed', http_status: 500, sent_at: null },
    { group_id: 'group-b', status: 'failed', http_status: null, sent_at: null },
    { group_id: 'group-c', status: 'sent', http_status: null, sent_at: expect.any(Number) },
  ])
  expect(log.mock.calls).toEqual([
    ['LINE deadline reminder failed', { retryKey: expect.any(String), targetDate: nextDay, kind: 'http', httpStatus: 500 }],
    ['LINE deadline reminder failed', { retryKey: expect.any(String), targetDate: nextDay, kind: 'network', httpStatus: null }],
  ])
})

test('keeps an oversized group reminder in one LINE text message', async () => {
  await platform.env.DB.batch(Array.from({ length: 30 }, () => addTask('group-a', '🐈'.repeat(100))))
  await runCron()
  const text = (await batches()).results[0].message_text as string
  expect(text.length).toBeLessThanOrEqual(5000)
  expect(text).toMatch(/\nほか\d+件$/)
  expect(fetch).toHaveBeenCalledTimes(1)
})
