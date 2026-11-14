import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery, type PlatformProxy } from 'wrangler'
import initialMigration from '../migrations/0001_init.sql?raw'
import reminderMigration from '../migrations/0002_notification_batches.sql?raw'
import retryMigration from '../migrations/0003_notification_retries.sql?raw'
import worker from '../src/index'
import { deadlineCron, retryCron } from '../src/reminders'

const scheduledTime = Date.parse('2030-12-31T11:00:00Z')
const nextDay = '2031-01-01'
const minute = 60_000
const day = 24 * 60 * minute
let platform: PlatformProxy<Env>

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ persist: false, remoteBindings: false, envFiles: [] })
  const { DB } = platform.env
  for (const migration of [initialMigration, reminderMigration, retryMigration]) {
    await DB.batch(unstable_splitSqlQuery(migration).map((sql) => DB.prepare(sql)))
  }
}, 20_000)

afterAll(async () => await platform?.dispose())

beforeEach(async () => {
  const { DB } = platform.env
  await DB.batch([DB.prepare('DELETE FROM tasks'), DB.prepare('DELETE FROM notification_batches')])
  setTime(scheduledTime)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setTime(time: number) {
  vi.spyOn(Date, 'now').mockReturnValue(time)
}

function runCron(time = scheduledTime, cron = deadlineCron) {
  return worker.scheduled({ scheduledTime: time, cron, noRetry: vi.fn() }, {
    ...platform.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
  })
}

function runRetry(afterMinutes: number) {
  const time = scheduledTime + afterMinutes * minute
  setTime(time)
  return runCron(time, retryCron)
}

function requestAt(index: number) {
  const [, request] = vi.mocked(fetch).mock.calls[index]
  return { body: request?.body, key: new Headers(request?.headers).get('X-Line-Retry-Key') }
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

test('migrates older sent, pending, retryable and permanent batches without changing their keys or bodies', async () => {
  const legacy = await getPlatformProxy<Env>({ persist: false, remoteBindings: false, envFiles: [] })
  const { DB } = legacy.env
  try {
    for (const migration of [initialMigration, reminderMigration]) {
      await DB.batch(unstable_splitSqlQuery(migration).map((sql) => DB.prepare(sql)))
    }
    const insert = DB.prepare(`
      INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, status, http_status, created_at)
      VALUES (?, ?, 'saved text', ?, ?, ?, ?)
    `)
    await DB.batch([
      insert.bind('a', nextDay, 'key-a', 'sent', null, scheduledTime),
      insert.bind('b', nextDay, 'key-b', 'pending', null, scheduledTime),
      insert.bind('c', nextDay, 'key-c', 'failed', 500, scheduledTime),
      insert.bind('d', nextDay, 'key-d', 'failed', 401, scheduledTime),
    ])
    await DB.batch(unstable_splitSqlQuery(retryMigration).map((sql) => DB.prepare(sql)))
    const { results } = await DB.prepare('SELECT * FROM notification_batches ORDER BY group_id').all()
    expect(results).toMatchObject([
      { retry_key: 'key-a', status: 'sent', next_attempt_at: null },
      { retry_key: 'key-b', status: 'pending', lease_until: scheduledTime + 2 * minute, last_error_kind: 'unknown' },
      { retry_key: 'key-c', status: 'failed', next_attempt_at: scheduledTime + 5 * minute },
      { retry_key: 'key-d', status: 'failed', next_attempt_at: null },
    ])
    for (const row of results) expect(row).toMatchObject({
      message_text: 'saved text', attempt_count: 1, last_attempt_at: scheduledTime,
    })
  } finally {
    await legacy.dispose()
  }
}, 20_000)

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
    expect(row).toMatchObject({ status: 'pending', message_text: body.messages[0].text, retry_key: key,
      attempt_count: 1, lease_until: scheduledTime + 2 * minute })
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

test('recovers a pending attempt after its lease and uses the saved payload', async () => {
  await addTask('group-a', '水筒').run()
  await platform.env.DB.prepare(`
    INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, created_at,
      attempt_count, last_attempt_at, lease_until, last_error_kind)
    VALUES ('group-a', ?, '保存した本文', 'original-key', ?, 1, ?, ?, 'unknown')
  `).bind(nextDay, scheduledTime, scheduledTime, scheduledTime + 2 * minute).run()
  await runRetry(1)
  expect(fetch).not.toHaveBeenCalled()
  await runRetry(5)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(requestAt(0)).toEqual({
    body: JSON.stringify({ to: 'group-a', messages: [{ type: 'text', text: '保存した本文' }] }), key: 'original-key',
  })
  expect((await batches()).results).toMatchObject([
    { status: 'sent', message_text: '保存した本文', retry_key: 'original-key', attempt_count: 2 },
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

test('records HTTP and network errors, continues other groups, then retries with each original key and body', async () => {
  await platform.env.DB.batch(['group-a', 'group-b', 'group-c'].map((group) => addTask(group, '水筒')))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockRejectedValueOnce(new Error('network error'))
  await runCron()
  expect(fetch).toHaveBeenCalledTimes(3)
  expect((await batches()).results).toMatchObject([
    { group_id: 'group-a', status: 'failed', http_status: 500, sent_at: null, last_error_kind: 'http', attempt_count: 1,
      last_attempt_at: scheduledTime, next_attempt_at: scheduledTime + 5 * minute },
    { group_id: 'group-b', status: 'failed', http_status: null, sent_at: null, last_error_kind: 'network' },
    { group_id: 'group-c', status: 'sent', http_status: null, sent_at: expect.any(Number) },
  ])
  expect(log.mock.calls).toEqual([
    ['LINE deadline reminder failed', { retryKey: expect.any(String), targetDate: nextDay, kind: 'http', httpStatus: 500, attempt: 1 }],
    ['LINE deadline reminder failed', { retryKey: expect.any(String), targetDate: nextDay, kind: 'network', httpStatus: null, attempt: 1 }],
  ])

  await platform.env.DB.prepare("UPDATE tasks SET title = '変更された本文'").run()
  await runRetry(4)
  expect(fetch).toHaveBeenCalledTimes(3)
  await runRetry(5)
  await runRetry(10)
  expect(fetch).toHaveBeenCalledTimes(5)
  expect(requestAt(3)).toEqual(requestAt(0))
  expect(requestAt(4)).toEqual(requestAt(1))
  expect((await batches()).results).toMatchObject([
    { status: 'sent', attempt_count: 2 }, { status: 'sent', attempt_count: 2 }, { status: 'sent', attempt_count: 1 },
  ])
})

test('does not create fresh batches on the retry cron', async () => {
  await addTask('group-a', '水筒').run()
  await runRetry(5)
  expect(fetch).not.toHaveBeenCalled()
  expect((await batches()).results).toEqual([])
})

test.each([400, 401, 403, 409])('does not retry HTTP %i without an acceptance header', async (status) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await addTask('group-a', '水筒').run()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }))
  await runCron()
  await runRetry(60)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await batches()).results).toMatchObject([{ status: 'failed', http_status: status, next_attempt_at: null }])
})

test.each([null, '1800', 'Tue, 31 Dec 2030 11:30:00 GMT'])('backs off after 429 with Retry-After %s', async (retryAfter) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await addTask('group-a', '水筒').run()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, {
    status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  }))
  await runCron()
  const delay = retryAfter ? 30 : 15
  expect((await batches()).results).toMatchObject([{ status: 'failed', next_attempt_at: scheduledTime + delay * minute }])
  await runRetry(delay - 5)
  expect(fetch).toHaveBeenCalledTimes(1)
  await runRetry(delay)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(requestAt(1)).toEqual(requestAt(0))
})

test('does not retry when the 24-hour retry key window has elapsed', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await addTask('group-a', '水筒').run()
  vi.mocked(fetch).mockRejectedValueOnce(new Error('temporary failure'))
  await runCron()
  await runRetry(day / minute)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('backs off and stops after four attempts including the initial send', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await addTask('group-a', '水筒').run()
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }))
  await runCron()
  for (const [time, attempts] of [[5, 2], [10, 2], [15, 3], [30, 3], [35, 4], [60, 4]]) {
    await runRetry(time)
    expect(fetch).toHaveBeenCalledTimes(attempts)
  }
  expect((await batches()).results).toMatchObject([{ status: 'failed', next_attempt_at: null, attempt_count: 4 }])
})

test('does not send in parallel when the daily and retry crons overlap', async () => {
  await addTask('group-a', '水筒').run()
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockImplementationOnce(() => {
    started.resolve()
    return response.promise
  })
  const daily = runCron()
  try {
    await started.promise
    await Promise.all([runRetry(0), runRetry(0), runCron()])
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    response.resolve(new Response(null, { status: 200 }))
    await daily
  }
})

test('records a push timeout and retries with the original request', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('Test timeout', 'TimeoutError')))
  vi.mocked(fetch).mockImplementationOnce(async (_url, request) => {
    throw request?.signal?.reason
  })
  await addTask('group-a', '水筒').run()

  await runCron()
  expect((await batches()).results).toMatchObject([{ status: 'failed', last_error_kind: 'timeout' }])
  await runRetry(5)
  expect(requestAt(1)).toEqual(requestAt(0))
  expect((await batches()).results).toMatchObject([{ status: 'sent', attempt_count: 2 }])
})

test('isolates failed inserts and never sends a group without a persisted batch', async () => {
  const { DB } = platform.env
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await DB.batch([addTask('group-a', '家族のタスク'), addTask('group-b', '水筒')])
  await DB.prepare(`CREATE TRIGGER fail_insert BEFORE INSERT ON notification_batches
    WHEN NEW.group_id = 'group-a' BEGIN SELECT RAISE(ABORT, 'private db detail'); END`).run()
  try {
    await runCron()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(requestAt(0).body)).to).toBe('group-b')
    expect((await batches()).results).toMatchObject([{ group_id: 'group-b', status: 'sent' }])
    expect(log.mock.calls).toEqual([
      ['Deadline reminder group failed', { targetDate: nextDay, retryKey: expect.any(String), stage: 'insert', kind: 'd1' }],
    ])
  } finally {
    await DB.prepare('DROP TRIGGER fail_insert').run()
  }
})

test('isolates failed result updates and recovers a LINE-accepted send through 409', async () => {
  const { DB } = platform.env
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await DB.batch([addTask('group-a', '家族のタスク'), addTask('group-b', '水筒')])
  await DB.prepare(`CREATE TRIGGER fail_result BEFORE UPDATE ON notification_batches
    WHEN NEW.group_id = 'group-a' AND NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'private db detail'); END`).run()
  try {
    await runCron()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect((await batches()).results).toMatchObject([
      { status: 'pending', last_error_kind: 'unknown', attempt_count: 1 }, { status: 'sent' },
    ])
    expect(log.mock.calls).toEqual([
      ['Deadline reminder group failed', { targetDate: nextDay, retryKey: requestAt(0).key, stage: 'save_result', kind: 'd1' }],
    ])
  } finally {
    await DB.prepare('DROP TRIGGER fail_result').run()
  }
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, {
    status: 409, headers: { 'X-Line-Accepted-Request-Id': 'test-accepted' },
  }))
  await Promise.all([runRetry(5), runRetry(5)])
  await runRetry(10)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(requestAt(2)).toEqual(requestAt(0))
  expect((await batches()).results).toMatchObject([{ status: 'sent', attempt_count: 2 }, { status: 'sent', attempt_count: 1 }])
})

test('keeps an oversized group reminder in one LINE text message', async () => {
  await platform.env.DB.batch(Array.from({ length: 30 }, () => addTask('group-a', '🐈'.repeat(100))))
  await runCron()
  const text = (await batches()).results[0].message_text as string
  expect(text.length).toBeLessThanOrEqual(5000)
  expect(text).toMatch(/\nほか\d+件$/)
  expect(fetch).toHaveBeenCalledTimes(1)
})
