import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { runReminders } from '../src/reminders'
import { dispatchAction } from '../src/tasks/actions'
import { testPlatform } from './platform'

let platform: Awaited<ReturnType<typeof testPlatform>>
const base = Date.parse('2030-12-01T10:00:00+09:00')
const slot = Date.parse('2030-12-13T20:00:00+09:00')
const fetchMock = vi.fn<typeof fetch>()
let env: Env

beforeAll(async () => {
  platform = await testPlatform()
  env = { ...platform.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' }
}, 20_000)
afterAll(async () => await platform?.dispose())
beforeEach(async () => {
  await env.DB.batch(['reminder_occurrences', 'tasks', 'task_contexts', 'processed_events', 'notification_batches']
    .map((table) => env.DB.prepare('DELETE FROM ' + table)))
  fetchMock.mockReset().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function event(now = base, groupId = 'group-a') {
  return { groupId, userId: 'user-a', eventId: crypto.randomUUID(), eventTime: now, now }
}
function create(title = '遠足', group = 'group-a') {
  return dispatchAction(env.DB, event(base, group), { type: 'create_task', title, dueDate: '2030-12-20', category: 'deadline' })
}
function run(at = slot) { return runReminders(env, () => at) }
function rows() { return env.DB.prepare('SELECT * FROM reminder_occurrences ORDER BY scheduled_at, task_id').all() }
function packet(index: number) {
  const [url, request] = fetchMock.mock.calls[index]
  return { url, body: request?.body, retryKey: new Headers(request?.headers).get('X-Line-Retry-Key') }
}

test('sends each task once on overlapping scheduler runs and advances to the next date', async () => {
  await create('遠足')
  await create('水筒', 'group-b')
  await Promise.all([run(), run()])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect((await rows()).results).toMatchObject([{ status: 'sent', attempt_count: 1 }, { status: 'sent', attempt_count: 1 }])
  expect(packet(0).url).toBe('https://api.line.me/v2/bot/message/push')
  expect(JSON.parse(String(packet(0).body))).toMatchObject({ messages: [{ text: expect.stringMatching(/^期限まであと7日です：/) }] })
  await run(Date.parse('2030-12-19T20:00:00+09:00'))
  expect(fetchMock).toHaveBeenCalledTimes(4)
})

test.each([500, 429, 'network', 'timeout'])('retries %s using the stored body and key', async (failure) => {
  if (failure === 'timeout') {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('timeout', 'TimeoutError')))
  }
  fetchMock.mockImplementationOnce(async () => {
    if (typeof failure === 'string') throw new Error(failure)
    return new Response(null, { status: failure, headers: { 'Retry-After': '1800' } })
  })
  await create()
  await run()
  const delay = failure === 429 ? 30 * 60_000 : 5 * 60_000
  expect((await rows()).results[0]).toMatchObject({ status: 'failed', attempt_count: 1, next_attempt_at: slot + delay })
  await run(slot + delay - 1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await run(slot + delay)
  await run(slot + delay + 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(packet(1)).toEqual(packet(0))
  expect((await rows()).results[0]).toMatchObject({ status: 'sent', attempt_count: 2 })
})

test.each([400, 401, 403, 409])('stops retrying permanent HTTP %i', async (status) => {
  await create()
  fetchMock.mockImplementation(async () => new Response(null, { status }))
  await run()
  await run(slot + 10 * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((await rows()).results[0]).toMatchObject({ status: 'failed', next_attempt_at: null })
})

test('stops on the maximum attempt count', async () => {
  await create()
  fetchMock.mockImplementation(async () => new Response(null, { status: 500 }))
  for (const minutes of [0, 5, 15, 35, 45]) await run(slot + minutes * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(4)
  expect((await rows()).results[0]).toMatchObject({ status: 'failed', attempt_count: 4, next_attempt_at: null })
})

test('omits expired slots and retries after midnight, even when only minutes have passed', async () => {
  await create()
  await run(slot + 61 * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(0)
  const daily = { type: 'offsets', slots: [{ daysBefore: 1, time: '23:59' }] } as const
  await dispatchAction(env.DB, event(), { type: 'create_task', title: '深夜', dueDate: '2030-12-20', category: 'deadline',
    rule: { ...daily, slots: [...daily.slots] } })
  const late = Date.parse('2030-12-19T23:59:00+09:00')
  await run(late + 60_000)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([true, false])('recovers a LINE-accepted send after a D1 failure (409 has ID: %s)', async (hasId) => {
  await create('遠足', 'group-a')
  await create('水筒', 'group-b')
  await env.DB.prepare(`CREATE TRIGGER fail_result BEFORE UPDATE ON reminder_occurrences
    WHEN NEW.group_id = 'group-a' AND NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run()
  try {
    await run()
    expect((await rows()).results).toMatchObject([{ status: 'pending', last_error_kind: 'unknown' }, { status: 'sent' }])
  } finally {
    await env.DB.prepare('DROP TRIGGER fail_result').run()
  }
  fetchMock.mockResolvedValueOnce(new Response(hasId ? '{"sentMessages":[{"id":"9007199254740993"}]}' : '{}', {
    status: 409, headers: { 'X-Line-Accepted-Request-Id': 'accepted' },
  }))
  await run(slot + 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await Promise.all([run(slot + 120_000), run(slot + 120_000)])
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(packet(2)).toEqual(packet(0))
  expect((await rows()).results[0]).toMatchObject({ status: 'sent', line_message_id: hasId ? '9007199254740993' : null })
})

test('keeps the failed group isolated and retries an unpersisted occurrence on the next run', async () => {
  await create('遠足', 'group-a')
  await create('水筒', 'group-b')
  await env.DB.prepare(`CREATE TRIGGER fail_insert BEFORE INSERT ON reminder_occurrences
    WHEN NEW.group_id = 'group-a' BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run()
  try {
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(packet(0).body)).to).toBe('group-b')
  } finally {
    await env.DB.prepare('DROP TRIGGER fail_insert').run()
  }
  await run(slot + 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(JSON.parse(String(packet(1).body)).to).toBe('group-a')
})

test('invalidates an already saved unsent occurrence after a setting change', async () => {
  await create()
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
  await run()
  await dispatchAction(env.DB, event(slot + 1), { type: 'set_reminder', target: { by: 'name', name: '遠足' },
    setting: { by: 'rule', rule: { type: 'offsets', slots: [{ daysBefore: 1, time: '21:00' }] } } })
  await run(slot + 5 * 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await run(Date.parse('2030-12-19T21:00:00+09:00'))
  expect((await rows()).results).toMatchObject([{ status: 'failed' }, { status: 'sent', rule_version: 2 }])
})

test('keeps existing task data and legacy sent history, initializes only future notifications', async () => {
  await env.DB.prepare(`INSERT INTO tasks (group_id, category, title, due_date, created_by, created_at, reminder_anchor, next_reminder_at)
    VALUES ('legacy', 'deadline', '既存の課題', '2030-12-20', 'user', ?, ?, 0)`).bind(base, base).run()
  await env.DB.prepare(`INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, status, created_at)
    VALUES ('legacy', '2030-12-20', '旧通知', 'original', 'sent', ?)`).bind(base).run()
  await run(base)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await env.DB.prepare('SELECT title, next_reminder_at FROM tasks WHERE group_id = ?').bind('legacy').first())
    .toMatchObject({ title: '既存の課題', next_reminder_at: slot })
  expect(await env.DB.prepare('SELECT retry_key FROM notification_batches').first()).toMatchObject({ retry_key: 'original' })
})

test('does not repeat the previous group notice at the same pre-deadline slot', async () => {
  await create()
  await run(slot)
  const eve = Date.parse('2030-12-19T20:00:00+09:00')
  await env.DB.prepare(`INSERT INTO notification_batches (group_id, target_due_date, message_text, retry_key, status, created_at)
    VALUES ('group-a', '2030-12-20', '旧通知', 'original', 'pending', ?)`).bind(eve).run()
  await run(eve)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((await rows()).results).toHaveLength(1)
})

test('keeps later same-day slots when recovering from a stale slot', async () => {
  await dispatchAction(env.DB, event(), { type: 'create_task', title: '提出物', dueDate: '2030-12-20', category: 'deadline',
    rule: { type: 'offsets', slots: [{ daysBefore: 1, time: '18:00' }, { daysBefore: 1, time: '20:00' }] } })
  const recovery = Date.parse('2030-12-19T20:10:00+09:00')
  await run(recovery)
  expect(fetchMock).not.toHaveBeenCalled()
  await run(recovery + 60_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect((await rows()).results[0]).toMatchObject({ scheduled_at: Date.parse('2030-12-19T20:00:00+09:00') })
})
