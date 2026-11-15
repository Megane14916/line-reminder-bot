import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import worker, { app } from '../src/index'
import { parseIntent } from '../src/line/intent-parser'
import { acceptEvents, drainInbox } from '../src/line/inbox'
import { drainResults, failedInference, unknownOperation } from '../src/line/outbox'
import { runtimeBudget, withinBudget } from '../src/runtime-budget'
import { runReminders } from '../src/reminders'
import { testPlatform } from './platform'

const secret = 'test-secret'
const now = Date.parse('2030-12-01T10:00:00+09:00')
const group = 'group-a'
const model = '@cf/qwen/qwen3-30b-a3b-fp8'
const infer = vi.fn()
const ai = { run: infer } as unknown as Ai
let platform: Awaited<ReturnType<typeof testPlatform>>
const line = vi.fn<typeof fetch>()
const byName = (name: string) => ({ by: 'name', name })
const recent = { by: 'recent' }

beforeAll(async () => { platform = await testPlatform() }, 20_000)
afterAll(async () => await platform?.dispose())
beforeEach(async () => {
  const { DB } = platform.env
  await DB.batch(['task_conversation', 'operation_result_outbox', 'reminder_occurrences', 'tasks', 'task_contexts', 'processed_events', 'group_reminder_defaults',
    'webhook_inbox', 'webhook_group_progress']
    .map((table) => DB.prepare('DELETE FROM ' + table)))
  vi.spyOn(Date, 'now').mockReturnValue(now)
  infer.mockReset()
  line.mockReset().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', line)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function webhookEnv() {
  return { ...platform.env, LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: 'test-token', AI: ai, AI_MODEL: model } as const
}

async function webhook(events: unknown[], options: { raw?: string; tampered?: boolean; missing?: boolean; work?: Promise<unknown>[] } = {}) {
  const body = options.raw ?? JSON.stringify({ events })
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))
  const work = options.work ?? []
  const response = await app.request('/webhook/line', {
    method: 'POST', body: options.tampered ? body + '\\n' : body,
    headers: options.missing ? {} : { 'x-line-signature': signature },
  }, webhookEnv(),
  { waitUntil: (promise) => { work.push(promise) }, passThroughOnException: vi.fn(), props: {} })
  if (!options.work) await Promise.all(work)
  return response
}

function event(text: string, options: { mention?: boolean; groupId?: string; userId?: string; quote?: string; id?: string; timestamp?: number } = {}) {
  const bot = '@家族Bot'
  return {
    type: 'message', mode: 'active', webhookEventId: options.id ?? crypto.randomUUID(),
    timestamp: options.timestamp ?? Date.now(), replyToken: 'test-reply-token',
    source: { type: 'group', groupId: options.groupId ?? group, userId: options.userId ?? 'user-a' },
    message: { type: 'text', text: options.mention ? bot + (text ? ' ' + text : '') : text,
      mention: options.mention ? { mentionees: [{ isSelf: true, index: 0, length: bot.length }] } : undefined,
      quotedMessageId: options.quote },
  }
}

async function command(text: string, action: unknown, options: Parameters<typeof event>[1] = {}) {
  infer.mockResolvedValueOnce({ response: action })
  expect((await webhook([event(text, { mention: true, ...options })])).status).toBe(200)
  return lastReply()
}

function lastReply() {
  const match = line.mock.calls.filter(([url]) => String(url).endsWith('/reply')).at(-1)
  return match && JSON.parse(String(match[1]?.body)).messages[0].text as string | undefined
}

function taskRows() {
  return platform.env.DB.prepare('SELECT * FROM tasks ORDER BY id').all()
}

test.each([
  ['update_task', 'update_task', '期限', { due_date: '2030-12-25' }],
  ['disable_reminder', 'enable_reminder', '通知', { reminder_enabled: 1 }],
  ['complete_task', 'reopen_task', '完了', { status: 'open' }],
  ['delete_task', 'restore_task', '削除', { deleted_at: null }],
] as const)('serializes %s then %s when the second result is ready first', async (earlier, later, label, expected) => {
  await command('レポート登録', create)
  const first = Promise.withResolvers<unknown>()
  const second = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<void>()
  const work: Promise<unknown>[] = []
  const one = event('レポートの' + label + 'を変更', { mention: true, timestamp: now + 1 })
  const two = event(later === 'update_task' ? 'やっぱり12月25日' : 'やっぱりレポートの操作を戻して',
    { mention: true, userId: later === 'update_task' ? 'user-a' : 'user-b', timestamp: now + 2 })
  infer.mockImplementationOnce(() => { started.resolve(); return first.promise }).mockImplementationOnce(() => second.promise)
  await webhook([one], { work })
  await started.promise
  second.resolve({ response: later === 'update_task' ? { type: later, target: recent, dueDate: '2030-12-25' }
    : { type: later, target: byName('レポート') } })
  await webhook([two])
  expect(infer).toHaveBeenCalledTimes(2)
  expect(await inbox(two.webhookEventId)).toMatchObject({ status: 'queued' })
  first.resolve({ response: earlier === 'update_task' ? { type: earlier, target: byName('レポート'), dueDate: '2030-12-23' }
    : { type: earlier, target: byName('レポート') } })
  await Promise.all(work)
  expect((await taskRows()).results).toMatchObject([expected])
  expect(await inbox(two.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1 })
  expect(await inbox(one.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1 })
}, 15_000)

test('rejects an older delivery after a newer update, including across users and on redelivery', async () => {
  await command('レポート登録', create)
  await command('レポートの締切を25日にして', { type: 'update_task', target: byName('レポート'), dueDate: '2030-12-25' },
    { timestamp: now + 2, userId: 'user-b' })
  const old = event('レポートを削除', { mention: true, timestamp: now + 1 })
  await webhook([old])
  expect(lastReply()).toContain('新しい操作')
  await webhook([old])
  expect(infer).toHaveBeenCalledTimes(2)
  expect((await taskRows()).results).toMatchObject([{ due_date: '2030-12-25', deleted_at: null }])
  expect(await inbox(old.webhookEventId)).toMatchObject({ status: 'failed', last_error: 'out_of_order', attempts: 1 })
})

test('ignores an old unrelated quote or a selection-shaped chat after a newer mutation', async () => {
  await command('レポート登録', create, { timestamp: now + 2 })
  line.mockClear()
  await webhook([
    event('終わった', { quote: '123456', timestamp: now + 1 }),
    event('#42', { timestamp: now + 1 }),
  ])
  expect(line).not.toHaveBeenCalled()
  expect(infer).toHaveBeenCalledTimes(1)
  expect((await taskRows()).results).toMatchObject([{ status: 'open' }])
})

test('uses D1 receipt order to break equal LINE timestamps, independent of event ID text', async () => {
  await command('レポート登録', create)
  const first = event('レポートを23日締切に', { mention: true, id: 'z-first', timestamp: now + 5 })
  const second = event('レポートを25日締切に', { mention: true, id: 'a-second', timestamp: now + 5 })
  infer.mockResolvedValueOnce({ response: { type: 'update_task', target: byName('レポート'), dueDate: '2030-12-23' } })
    .mockResolvedValueOnce({ response: { type: 'update_task', target: byName('レポート'), dueDate: '2030-12-25' } })
  await webhook([first, second])
  expect((await taskRows()).results).toMatchObject([{ due_date: '2030-12-25' }])
  expect(Number((await inbox(first.webhookEventId))?.receipt_id)).toBeLessThan(Number((await inbox(second.webhookEventId))?.receipt_id))
})

test('recovers a saved operation from Cron and expires an old abandoned attempt', async () => {
  const { DB } = platform.env
  const old = event('レポート登録', { mention: true })
  infer.mockRejectedValueOnce(new Error('test'))
  await webhook([old])
  await DB.prepare(`UPDATE webhook_inbox SET status = 'running', lease_until = ? WHERE event_id = ?`)
    .bind(now + 45_000, old.webhookEventId).run()

  const current = now + 15 * 60_000
  vi.mocked(Date.now).mockReturnValue(current)
  const saved = event('レポート登録', { mention: true })
  await acceptEvents(DB, [{ groupId: group, userId: 'user-a', eventId: saved.webhookEventId, eventTime: current,
    replyToken: 'test-reply-token', input: { type: 'intent', text: 'レポート登録' } }], current)
  infer.mockResolvedValueOnce({ response: create })
  await worker.scheduled({ cron: '* * * * *', scheduledTime: current, noRetry: vi.fn() }, webhookEnv())
  expect(await inbox(old.webhookEventId)).toMatchObject({ status: 'failed', last_error: 'expired', input_json: null, reply_token: null })
  expect(await inbox(saved.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1 })
  expect((await taskRows()).results).toHaveLength(1)
  await tick(current + 60_000)
  expect(pushes()[0].body).toEqual({ to: group, messages: [{ type: 'text', text: unknownOperation }] })
})

test('a slow group inference leaves another group free to commit first', async () => {
  const slow = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<void>()
  infer.mockImplementationOnce(() => { started.resolve(); return slow.promise }).mockResolvedValueOnce({ response: create })
  const work: Promise<unknown>[] = []
  const first = event('レポート登録', { mention: true })
  const second = event('レポート登録', { mention: true, groupId: 'group-b' })
  await webhook([first], { work })
  await started.promise
  await webhook([second])
  expect((await taskRows()).results).toMatchObject([{ group_id: 'group-b' }])
  slow.resolve({ response: create })
  await Promise.all(work)
  expect((await taskRows()).results).toMatchObject([{ group_id: 'group-b' }, { group_id: 'group-a' }])
})

test('keeps further events durable when the count or time budget runs out', async () => {
  const requests = Array.from({ length: 4 }, () => event('レポート登録', { mention: true }))
  infer.mockImplementationOnce(async () => {
    vi.mocked(Date.now).mockReturnValue(now + 11_999)
    return { response: create }
  }).mockResolvedValue({ response: create })
  await webhook(requests)
  expect(infer).toHaveBeenCalledTimes(1)
  expect(await inbox(requests[1].webhookEventId)).toMatchObject({ status: 'queued', attempts: 0 })
  await tick(now + 60_000)
  expect(infer).toHaveBeenCalledTimes(3)
  expect(await inbox(requests[3].webhookEventId)).toMatchObject({ status: 'queued', attempts: 0 })
  await tick(now + 120_000)
  expect((await taskRows()).results).toHaveLength(4)
  expect(line).toHaveBeenCalledTimes(4)
  expect(pushes()).toHaveLength(3)
})

test('one slow LINE reply does not hold the group lease or block the next operation', async () => {
  const pending = Promise.withResolvers<Response>()
  const sending = Promise.withResolvers<void>()
  line.mockImplementationOnce(() => { sending.resolve(); return pending.promise })
  infer.mockResolvedValue({ response: create })
  const requests = [event('レポート登録', { mention: true }), event('レポート登録', { mention: true })]
  const work: Promise<unknown>[] = []
  try {
    await webhook(requests, { work })
    await sending.promise
    await vi.waitFor(async () => expect(await inbox(requests[1].webhookEventId)).toMatchObject({ status: 'succeeded' }))
    expect((await taskRows()).results).toHaveLength(2)
  } finally {
    pending.resolve(new Response('{}'))
    await Promise.all(work)
  }
})

test('reserves time for result persistence and clips the LINE timeout to the shared deadline', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  infer.mockImplementationOnce(async () => {
    vi.mocked(Date.now).mockReturnValue(now + 21_000)
    return { response: create }
  })
  const request = event('レポート登録', { mention: true })
  await webhook([request])
  expect(timeout).toHaveBeenCalledWith(3000)
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', channel: 'reply' })
})

function inbox(eventId: string) {
  return platform.env.DB.prepare('SELECT * FROM webhook_inbox WHERE event_id = ?').bind(eventId).first()
}

function result(eventId: string) {
  return platform.env.DB.prepare('SELECT * FROM operation_result_outbox WHERE event_id = ?').bind(eventId).first()
}

function pushes() {
  return line.mock.calls.filter(([url]) => String(url).endsWith('/push')).map(([, init]) => ({
    body: JSON.parse(String(init?.body)), retryKey: new Headers(init?.headers).get('X-Line-Retry-Key'),
  }))
}

function tick(time: number) {
  vi.mocked(Date.now).mockReturnValue(time)
  const budget = runtimeBudget()
  return withinBudget(budget, async () => {
    await Promise.all([drainInbox(webhookEnv(), budget), drainResults(webhookEnv(), budget)])
  })
}

const create = { type: 'create_task', title: 'レポート', category: 'deadline', dueDate: '2030-12-20' }

test('returns 503 if the Inbox cannot save an event and accepts redelivery once it can', async () => {
  const { DB } = platform.env
  const request = event('レポートを登録', { mention: true })
  await DB.prepare(`CREATE TRIGGER fail_intake BEFORE INSERT ON webhook_inbox BEGIN SELECT RAISE(ABORT, 'test'); END`).run()
  try {
    expect((await webhook([request])).status).toBe(503)
    expect(await inbox(request.webhookEventId)).toBeNull()
    expect(infer).not.toHaveBeenCalled()
  } finally {
    await DB.prepare('DROP TRIGGER fail_intake').run()
  }
  infer.mockResolvedValue({ response: create })
  expect((await webhook([request])).status).toBe(200)
  await webhook([request])
  expect((await taskRows()).results).toHaveLength(1)
  expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1, input_json: null, reply_token: null })
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', channel: 'reply', text: null, reply_token: null })
  expect(pushes()).toHaveLength(0)
})

test('resumes a partially successful delivery after D1 fails and reuses the validated intent', async () => {
  const { DB } = platform.env
  const first = event('レポートを登録', { mention: true })
  const second = event('作文を登録', { mention: true, timestamp: now + 1 })
  const third = event('宿題を登録', { mention: true, timestamp: now + 2 })
  infer.mockResolvedValueOnce({ response: create }).mockResolvedValueOnce({ response: { ...create, title: '作文' } })
    .mockResolvedValueOnce({ response: { ...create, title: '宿題' } })
  await DB.prepare(`CREATE TRIGGER fail_create BEFORE INSERT ON tasks WHEN NEW.title = '作文' BEGIN SELECT RAISE(ABORT, 'test'); END`).run()
  try {
    expect((await webhook([first, second, third])).status).toBe(200)
    expect(await inbox(first.webhookEventId)).toMatchObject({ status: 'succeeded' })
    expect(await inbox(second.webhookEventId)).toMatchObject({ status: 'queued', last_error: 'd1_error', action_json: expect.stringContaining('作文') })
    expect(await DB.prepare('SELECT event_id FROM processed_events WHERE event_id = ?').bind(second.webhookEventId).first()).toBeNull()
    expect(await inbox(third.webhookEventId)).toMatchObject({ status: 'queued', attempts: 0 })
    expect((await taskRows()).results).toHaveLength(1)
  } finally {
    await DB.prepare('DROP TRIGGER fail_create').run()
  }
  await webhook([first, second, third])
  await tick(now + 15_000)
  expect((await taskRows()).results.map(({ title }) => title)).toEqual(['レポート', '作文', '宿題'])
  expect(infer).toHaveBeenCalledTimes(3)
  expect(await inbox(second.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 2, action_json: null })
  expect(await inbox(third.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1 })
})

test('a reply timeout after commit does not repeat the reply or mutation during concurrent redelivery', async () => {
  const request = event('レポートを登録', { mention: true })
  infer.mockResolvedValue({ response: create })
  const aborted = AbortSignal.abort(new DOMException('test', 'TimeoutError'))
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(aborted)
  line.mockImplementationOnce(async (_url, options) => { throw options?.signal?.reason })
  await Promise.all([webhook([request]), webhook([request])])
  await webhook([request])
  await tick(now + 60_000)
  expect(line).toHaveBeenCalledTimes(1)
  expect(infer).toHaveBeenCalledTimes(1)
  expect((await taskRows()).results).toHaveLength(1)
  expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1 })
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'uncertain', channel: 'reply', last_error: 'timeout' })
})

test('reclaims an interrupted lease and fences off the former worker when its inference finishes', async () => {
  const request = event('レポートを登録', { mention: true })
  const first = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<void>()
  const work: Promise<unknown>[] = []
  infer.mockImplementationOnce(() => { started.resolve(); return first.promise }).mockResolvedValueOnce({ response: create })
  expect((await webhook([request], { work })).status).toBe(200)
  await started.promise
  expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'running', attempts: 1 })
  await tick(now + 45_000)
  first.resolve({ response: { ...create, title: '古い推論' } })
  await Promise.all(work)
  expect((await taskRows()).results).toMatchObject([{ title: 'レポート' }])
  expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 2 })
})

test('stops retrying exhausted inference and scrubs the input and expired reply token', async () => {
  const request = event('レポートを登録', { mention: true })
  infer.mockRejectedValue(new Error('test'))
  await webhook([request])
  await tick(now + 15_000)
  await tick(now + 75_000)
  expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'failed', attempts: 3, last_error: 'ai_unavailable', input_json: null, reply_token: null })
  await tick(now + 120_000)
  expect(infer).toHaveBeenCalledTimes(3)
  expect(pushes()).toEqual([{ body: { to: group, messages: [{ type: 'text', text: failedInference }] }, retryKey: expect.any(String) }])
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', channel: 'push', push_attempts: 1, text: null })
  expect((await taskRows()).results).toEqual([])
})

test('uses Push for an expired reply token and does not send again on redelivery', async () => {
  const request = await queueCreate()
  infer.mockResolvedValue({ response: create })
  await tick(now + 60_000)
  await webhook([request])
  await tick(now + 120_000)
  expect(line).toHaveBeenCalledTimes(1)
  expect(pushes()).toEqual([{ body: { to: group, messages: [{ type: 'text', text: expect.stringContaining('登録しました') }] },
    retryKey: expect.any(String) }])
  expect((await taskRows()).results).toHaveLength(1)
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', channel: 'push', push_attempts: 1, text: null })
})

test('falls back after definitive Reply rejection without retrying the task', async () => {
  const request = event('レポート登録', { mention: true, groupId: 'group-b' })
  infer.mockResolvedValue({ response: create })
  line.mockResolvedValueOnce(new Response(null, { status: 400 }))
  await webhook([request])
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'push_pending', channel: 'reply', last_error: 'http_400' })
  expect((await taskRows()).results).toHaveLength(1)
  await tick(now + 60_000)
  await webhook([request])
  expect(pushes()).toEqual([{ body: { to: 'group-b', messages: [{ type: 'text', text: expect.stringContaining('登録しました') }] },
    retryKey: expect.any(String) }])
  const [, replyInit] = line.mock.calls[0]
  expect(new Headers(replyInit?.headers).has('X-Line-Retry-Key')).toBe(false)
  expect(infer).toHaveBeenCalledTimes(1)
  expect((await taskRows()).results).toHaveLength(1)
})

test.each(['500', 'timeout', '429'])('retries a failed Push with its original text and key (%s)', async (failure) => {
  const request = await queueCreate()
  infer.mockResolvedValue({ response: create })
  if (failure === 'timeout') {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('test', 'TimeoutError')))
    line.mockImplementationOnce(async (_url, init) => { throw init?.signal?.reason })
  } else {
    line.mockResolvedValueOnce(new Response(null, { status: Number(failure), headers: { 'Retry-After': '1200' } }))
  }
  await tick(now + 60_000)
  const retryAt = now + 60_000 + (failure === '429' ? 20 : 5) * 60_000
  expect(await result(request.webhookEventId)).toMatchObject({
    status: 'push_pending', push_attempts: 1, available_at: retryAt, last_error: failure === 'timeout' ? 'timeout' : 'http_' + failure,
  })
  await tick(retryAt - 1)
  expect(pushes()).toHaveLength(1)
  line.mockResolvedValueOnce(new Response(null, { status: 409, headers: { 'X-Line-Accepted-Request-Id': 'accepted' } }))
  await tick(retryAt)
  expect(pushes()).toHaveLength(2)
  expect(pushes()[1]).toEqual(pushes()[0])
  await tick(retryAt + 60_000)
  expect(pushes()).toHaveLength(2)
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', push_attempts: 2, text: null })
})

test('does not retry permanent Push errors or restart a Push with an expired key', async () => {
  const first = await queueCreate()
  const second = await queueCreate('group-b')
  infer.mockResolvedValue({ response: create })
  line.mockImplementation(async (_url, init) => new Response(null, {
    status: JSON.parse(String(init?.body)).to === group ? 403 : 500,
  }))
  await tick(now + 60_000)
  expect(await result(first.webhookEventId)).toMatchObject({ status: 'failed', last_error: 'http_403', text: null })
  expect(await result(second.webhookEventId)).toMatchObject({ status: 'push_pending', last_error: 'http_500' })
  await tick(now + 61 * 60_000)
  expect(pushes()).toHaveLength(2)
  expect(await result(second.webhookEventId)).toMatchObject({ status: 'failed', last_error: 'expired', text: null })
})

test('a failed Outbox insert rolls back the task and preserves the Inbox operation for retry', async () => {
  const { DB } = platform.env
  const request = event('レポート登録', { mention: true })
  infer.mockResolvedValue({ response: create })
  await DB.prepare(`CREATE TRIGGER fail_outbox BEFORE INSERT ON operation_result_outbox BEGIN SELECT RAISE(ABORT, 'test'); END`).run()
  try {
    expect((await webhook([request])).status).toBe(200)
    expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'queued', last_error: 'd1_error' })
    expect((await taskRows()).results).toEqual([])
    expect(await result(request.webhookEventId)).toBeNull()
    expect(line).not.toHaveBeenCalled()
  } finally {
    await DB.prepare('DROP TRIGGER fail_outbox').run()
  }
  await tick(now + 15_000)
  expect(infer).toHaveBeenCalledTimes(1)
  expect((await taskRows()).results).toHaveLength(1)
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent' })
})

test('recovers a Push lease using the same key and rejects the former worker’s late result', async () => {
  const request = await queueCreate()
  infer.mockResolvedValue({ response: create })
  const first = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  line.mockImplementationOnce(() => { started.resolve(); return first.promise })
  const work = tick(now + 60_000)
  await started.promise
  try {
    await tick(now + 61_000)
    expect(await result(request.webhookEventId)).toMatchObject({ status: 'pushing', push_attempts: 1 })
    expect(pushes()).toHaveLength(1)
    line.mockResolvedValueOnce(new Response(null, { status: 409, headers: { 'X-Line-Accepted-Request-Id': 'accepted' } }))
    await Promise.all([tick(now + 105_000), tick(now + 105_000)])
    expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', push_attempts: 2 })
  } finally {
    first.resolve(new Response(null, { status: 500 }))
    await work
  }
  expect(pushes()).toHaveLength(2)
  expect(pushes()[1]).toEqual(pushes()[0])
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', push_attempts: 2, last_error: null })
})

test('recovers the same Push when LINE accepts it but saving the delivery result fails', async () => {
  const { DB } = platform.env
  const request = await queueCreate()
  infer.mockResolvedValue({ response: create })
  await DB.prepare(`CREATE TRIGGER fail_delivery_result BEFORE UPDATE ON operation_result_outbox
    WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'test'); END`).run()
  try {
    await tick(now + 60_000)
    expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'succeeded' })
    expect(await result(request.webhookEventId)).toMatchObject({ status: 'pushing', push_attempts: 1, text: expect.any(String) })
  } finally {
    await DB.prepare('DROP TRIGGER fail_delivery_result').run()
  }
  line.mockResolvedValueOnce(new Response(null, { status: 409, headers: { 'X-Line-Accepted-Request-Id': 'accepted' } }))
  await tick(now + 120_000)
  expect(pushes()).toHaveLength(2)
  expect(pushes()[1]).toEqual(pushes()[0])
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'sent', push_attempts: 2, text: null })
  expect((await taskRows()).results).toHaveLength(1)
})

test('does not Push if a worker is interrupted while replying', async () => {
  const request = event('レポート登録', { mention: true })
  infer.mockResolvedValue({ response: create })
  const first = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const work: Promise<unknown>[] = []
  line.mockImplementationOnce(() => { started.resolve(); return first.promise })
  await webhook([request], { work })
  await started.promise
  try {
    expect(await result(request.webhookEventId)).toMatchObject({ status: 'replying' })
    await tick(now + 20_000)
    expect(pushes()).toHaveLength(0)
    await tick(now + 60_000)
    expect(await result(request.webhookEventId)).toMatchObject({ status: 'uncertain', last_error: 'reply_interrupted', text: null })
  } finally {
    first.resolve(new Response(null, { status: 200 }))
    await Promise.all(work)
  }
  expect(line).toHaveBeenCalledTimes(1)
  expect(await result(request.webhookEventId)).toMatchObject({ status: 'uncertain' })
})

async function queueCreate(groupId = group) {
  const request = event('レポート登録', { mention: true, groupId })
  await acceptEvents(platform.env.DB, [{ groupId, userId: 'user-a', eventId: request.webhookEventId,
    eventTime: now, replyToken: request.replyToken, input: { type: 'intent', text: 'レポート登録' } }], now)
  return request
}

test('validates signatures and empty events without invoking AI or LINE', async () => {
  expect((await webhook([])).status).toBe(200)
  expect((await webhook([], { missing: true })).status).toBe(401)
  expect((await webhook([], { tampered: true })).status).toBe(401)
  expect((await webhook([], { raw: '{' })).status).toBe(400)
  expect(infer).not.toHaveBeenCalled()
  expect(line).not.toHaveBeenCalled()
})

test('replies to a bot-only mention with text and ignores conversation, other mentions and legacy buttons', async () => {
  const other = event('こんにちは')
  const old = { ...other, type: 'postback', postback: { data: 'delete:1' } }
  await webhook([event('明日の夕飯？'), event('@家族Bot'), {
    ...other, message: { ...other.message, mention: { mentionees: [{ isSelf: false, index: 0, length: 2 }] } },
  }, old])
  expect(line).not.toHaveBeenCalled()
  await webhook([event('', { mention: true })])
  const help = lastReply()
  expect(help).toMatch(/^📖 Botの使い方\n\nBotをメンションして/)
  expect(help).toContain('\n\n📝 タスクの登録\n「12月20日までにレポート提出」\n\n📋 タスクの確認')
  expect(help).toContain('メンションなしで操作できます。')
  expect(infer).not.toHaveBeenCalled()
  expect(await command('使い方を教えて', { type: 'help' })).toBe(help)
  expect(await command('分からない操作', { type: 'unknown' }))
    .toBe('💬 うまく読み取れませんでした。\nもう少し詳しく教えてください。')
})

test('creates and deduplicates a related create-and-reminder request and lists by date and category', async () => {
  const request = event('12月20日のレポートを登録。1週間前から毎日通知して', { mention: true })
  const rule = { type: 'repeat', startDaysBefore: 7, endDaysBefore: 1, everyDays: 1, weekdays: [], times: ['20:00'] }
  infer.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    type: 'create_task', title: 'レポート', category: 'deadline', dueDate: '2030-12-20', rule,
  }) } }] })
  await webhook([request])
  await webhook([request])
  expect(infer).toHaveBeenCalledTimes(1)
  expect(infer.mock.calls[0][1]).toMatchObject({ messages: [expect.anything(), { role: 'user', content: '12月20日のレポートを登録。1週間前から毎日通知して' }],
    response_format: { type: 'json_object' } })
  expect(lastReply()).toBe('✅ タスクを登録しました\n\nレポート\n期限：12月20日（金）\n種類：提出物\n通知：7日前から前日まで毎日\n時刻：20:00')
  expect((await taskRows()).results).toMatchObject([{ reminder_rule: JSON.stringify(rule), next_reminder_at: Date.parse('2030-12-13T20:00:00+09:00') }])
  expect(await command('12月の提出物', { type: 'list_tasks', from: '2030-12-01', to: '2030-12-31', category: 'deadline' }))
    .toBe('📋 未完了のタスク（1件）\n\nレポート\n期限：12月20日（金）｜提出物')
})

test('updates, completes, reopens, logically deletes, restores and manages notifications through recent context', async () => {
  await command('12月20日までにレポート提出', { type: 'create_task', title: 'レポート', category: 'deadline', dueDate: '2030-12-20' })
  expect(await command('レポートを作文に変えて12月23日締切', { type: 'update_task', target: byName('レポート'),
    title: '作文', dueDate: '2030-12-23' })).toBe('✏️ タスクを変更しました\n\n作文\n期限：12月23日（月）\n種類：提出物\n通知：7日前・前日 20:00')
  expect(await command('やっぱり3日前と前日だけ', { type: 'set_reminder', target: recent, setting: { by: 'rule',
    rule: { type: 'offsets', slots: [{ daysBefore: 3, time: '20:00' }, { daysBefore: 1, time: '20:00' }] } } }))
    .toContain('通知：3日前・前日 20:00\n次回：12月20日（金）20:00')
  expect(await command('通知時間を全部21時に変えて', { type: 'set_reminder', target: recent,
    setting: { by: 'time', time: '21:00' } })).toContain('21:00')
  expect(await command('このタスクはいつ通知？', { type: 'get_reminder', target: recent }))
    .toBe('🔔 通知設定\n\n作文\n期限：12月23日（月）\n通知：3日前・前日 21:00\n次回：12月20日（金）21:00')
  expect(await command('通知停止', { type: 'disable_reminder', target: recent })).toContain('\n通知：停止中')
  expect((await taskRows()).results[0].next_reminder_at).toBeNull()
  expect(await command('作文を持ち物に変えて', { type: 'update_task', target: byName('作文'), category: 'belonging' }))
    .toBe('✏️ タスクを変更しました\n\n作文\n期限：12月23日（月）\n種類：持ち物\n通知：停止中')
  await command('通知を再開', { type: 'enable_reminder', target: recent })
  expect((await taskRows()).results[0].next_reminder_at).toBe(Date.parse('2030-12-20T21:00:00+09:00'))
  await command('作文終わった', { type: 'complete_task', target: byName('作文') })
  expect((await taskRows()).results[0]).toMatchObject({ status: 'done', next_reminder_at: null })
  await command('作文を未完了に戻して', { type: 'reopen_task', target: byName('作文') })
  expect((await taskRows()).results[0]).toMatchObject({ status: 'open', next_reminder_at: expect.any(Number) })
  await command('作文を削除して', { type: 'delete_task', target: byName('作文') })
  expect((await taskRows()).results[0]).toMatchObject({ deleted_at: now, next_reminder_at: null })
  await command('作文を復元して', { type: 'restore_task', target: byName('作文') })
  expect((await taskRows()).results[0]).toMatchObject({ deleted_at: null, next_reminder_at: expect.any(Number) })
}, 15_000)

test('keeps ambiguous selection scoped to the initiating user and group', async () => {
  for (const dueDate of ['2030-12-20', '2030-12-23']) {
    await command('水筒を登録', { type: 'create_task', title: '水筒', category: 'belonging', dueDate })
  }
  const [first, second] = (await taskRows()).results
  const token = '#' + second.id
  expect(await command('水筒完了', { type: 'complete_task', target: byName('水筒') }))
    .toContain(`選択用の番号を、#も付けてメンションなしで送ってください。\n\n#${first.id} 水筒\n期限：12月20日（金）｜持ち物\n\n${token} 水筒`)
  await webhook([event(token, { userId: 'user-b' }), event(token, { groupId: 'group-b' })])
  expect((await taskRows()).results).toMatchObject([{ status: 'open' }, { status: 'open' }])
  await webhook([event(token)])
  expect((await taskRows()).results).toMatchObject([{ id: first.id, status: 'open' }, { id: second.id, status: 'done' }])
  expect(await command(token + '削除', { type: 'delete_task', target: { by: 'id', id: second.id } }, { groupId: 'group-b' })).toContain('見つかりません')
  expect(await command('やっぱり通知停止', { type: 'disable_reminder', target: recent }, { userId: 'user-b' })).toContain('どのタスク')
}, 15_000)

test('uses a group default only for subsequently registered tasks in that group', async () => {
  const task = { type: 'create_task', title: '提出物', category: 'deadline', dueDate: '2030-12-20' }
  await command('提出物登録', task)
  const rule = { type: 'offsets', slots: [{ daysBefore: 1, time: '21:00' }] }
  expect(await command('今後登録するタスクは前日21時', { type: 'set_group_default', rule }))
    .toBe('🔔 今後登録するタスクの通知設定を変更しました\n\n通知：前日 21:00')
  await command('提出物登録', task)
  await command('提出物登録', task, { groupId: 'group-b' })
  expect((await taskRows()).results.map((row) => JSON.parse(String(row.reminder_rule)))).toEqual([{ type: 'default' }, rule, { type: 'default' }])
})

test('lists 20 ordered tasks without IDs and fits the LINE limit with legacy titles', async () => {
  const { DB } = platform.env
  const longTitle = '🏃'.repeat(100)
  await DB.batch(Array.from({ length: 21 }, (_, index) => DB.prepare(`INSERT INTO tasks
    (group_id, category, title, due_date, created_by, created_at) VALUES (?, ?, ?, ?, 'user-a', ?)`)
    .bind(group, index === 20 ? 'belonging' : 'deadline',
      index === 20 ? '水筒\r\n（予備）\u2028🧊' : index === 19 ? '最後のタスク' : longTitle,
      index === 20 ? '2030-12-20' : index === 19 ? '2030-12-22' : '2030-12-21', now)))
  const list = await command('未完了のタスクを教えて', { type: 'list_tasks' })
  expect(list).toBeDefined()
  const blocks = list!.split('\n\n')
  expect(blocks[0]).toBe('📋 未完了のタスク（20件）')
  expect(blocks.slice(1, -1)).toEqual([
    '水筒 （予備） 🧊\n期限：12月20日（金）｜持ち物',
    ...Array<string>(19).fill(`${longTitle}\n期限：12月21日（土）｜提出物`),
  ])
  expect(blocks.at(-1)).toBe('最初の20件を表示しています。')
  expect(list).not.toMatch(/#\d+/)
  expect(list!.length).toBeLessThanOrEqual(5000)
})

test.each([
  { status: 'done', operation: 'complete_task', label: '完了済み' },
  { status: 'deleted', operation: 'delete_task', label: '削除済み' },
])('uses the same list format for $status and keeps filtering by category', async ({ status, operation, label }) => {
  await command('レポートを登録', create)
  await command('レポートを操作', { type: operation, target: byName('レポート') })
  expect(await command('該当する提出物', { type: 'list_tasks', status, category: 'deadline' }))
    .toBe(`📋 ${label}のタスク（1件）\n\nレポート\n期限：12月20日（金）｜提出物`)
  expect(await command('該当する持ち物', { type: 'list_tasks', status, category: 'belonging' }))
    .toBe('該当するタスクはありません。')
})

test.each([
  { type: 'create_task', title: 'test', category: 'deadline', dueDate: '2030-02-30' },
  { type: 'create_task', title: 'test', category: 'deadline', dueDate: '2029-12-30' },
  { type: 'delete_all' },
  { type: 'create_task', title: 'test', category: 'deadline', dueDate: '2030-12-20', groupId: 'group-b' },
  [{ type: 'help' }, { type: 'unknown' }], '{',
])('validates AI output before running database actions (%j)', async (action) => {
  const request = event('テスト', { mention: true })
  infer.mockResolvedValueOnce({ response: action })
  await webhook([request])
  expect((await taskRows()).results).toEqual([])
  expect(lastReply()).toMatch(/読み取れ|過去/)
  if (lastReply()?.includes('読み取れ')) {
    expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'failed', last_error: 'invalid_intent', input_json: null, attempts: 1 })
    await tick(now + 60_000)
    expect(infer).toHaveBeenCalledTimes(1)
  }
})

test('queues a retry on inference failures and classifies inference timeout', async () => {
  infer.mockImplementationOnce(() => new Promise(() => {}))
  await expect(parseIntent(ai, model, '今日の締切', now, 5)).resolves.toEqual({ kind: 'timeout' })
  expect(infer.mock.calls[0][2].signal.aborted).toBe(true)
  infer.mockRejectedValueOnce(new Error('network failed'))
  const query = event('今日の締切', { mention: true })
  await webhook([query])
  expect(await inbox(query.webhookEventId)).toMatchObject({ status: 'queued', last_error: 'ai_unavailable', attempts: 1 })
  expect(line).not.toHaveBeenCalled()
  infer.mockResolvedValueOnce({ response: { type: 'list_tasks' } })
  await tick(now + 15_000)
  expect(await inbox(query.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 2 })
  expect(lastReply()).toContain('該当するタスクはありません')
})

test.each(['終わった', '完了', '✅'])('quotes an accepted push to complete once and stop future notices (%s)', async (text) => {
  await command('水筒を登録', { type: 'create_task', title: '水筒', category: 'belonging', dueDate: '2030-12-20' })
  const slot = Number((await taskRows()).results[0].next_reminder_at)
  line.mockImplementation(async (url) => String(url).endsWith('/push')
    ? new Response('{"sentMessages":[{"id":987654321012345678}]}') : new Response('{}'))
  const env = { ...platform.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' }
  await runReminders(env, () => slot)
  expect(pushes()).toMatchObject([{ body: { messages: [
    { type: 'text', text: '🔔 リマインダー\n\n水筒\n期限：12月20日（金）\n締切まであと7日' },
  ] } }])
  expect((await platform.env.DB.prepare('SELECT * FROM reminder_occurrences').first())).toMatchObject({ line_message_id: '987654321012345678' })
  await webhook([event('ありがとう', { quote: '987654321012345678' }), event(text, { quote: '987654321012345678', groupId: 'group-b' })])
  expect((await taskRows()).results[0].status).toBe('open')
  const completion = event(text, { quote: '987654321012345678', timestamp: slot })
  vi.spyOn(Date, 'now').mockReturnValue(slot)
  await webhook([completion])
  expect(lastReply()).toContain('完了にしました')
  const completed = (await taskRows()).results[0]
  await webhook([completion, event(text, { quote: '987654321012345678' })])
  expect((await taskRows()).results[0]).toEqual(completed)
  await runReminders(env, () => Date.parse('2030-12-19T20:00:00+09:00'))
  expect(line.mock.calls.filter(([url]) => String(url).endsWith('/push'))).toHaveLength(1)
})

const conversationNow = Date.parse('2030-11-25T10:00:00+09:00')
const application = { type: 'create_task', title: '英検申し込み', category: 'deadline', dueDate: '2030-12-14' }
const fourteenth = { daysBefore: 14, time: '20:00' }
const seventh = { daysBefore: 7, time: '20:00' }
const eve = { daysBefore: 1, time: '20:00' }
const addTwoWeeks = { mode: 'add', slots: [fourteenth] }

function edit(edit: unknown, target: unknown = recent) {
  return { type: 'modify_reminder', target, edit }
}

test.each([
  ['英検申し込みの通知の方法について、2週間前にも通知して', byName('英検申し込み'), false],
  ['英検申し込み、2週間前にも教えて', byName('英検'), false],
  ['さっきのやつ、14日前も', recent, false],
  ['2週間前にも', recent, true],
] as const)('keeps the existing notices when the user says %s', async (text, target, quoted) => {
  vi.spyOn(Date, 'now').mockReturnValue(conversationNow)
  const messageId = '985420000000000019'
  line.mockResolvedValueOnce(new Response('{"sentMessages":[{"id":985420000000000019}]}'))
  const registration = event('12/14までに英検申し込み', { mention: true })
  infer.mockResolvedValueOnce({ response: application })
  await webhook([registration])
  const [registered] = (await taskRows()).results
  expect(await result(registration.webhookEventId)).toMatchObject({ line_message_id: messageId, task_id: registered.id })
  expect(lastReply()).toContain('通知：7日前・前日 20:00')

  const request = event(text, { mention: !quoted, quote: quoted ? messageId : undefined })
  if (!quoted) infer.mockResolvedValueOnce({ response: edit(addTwoWeeks, target) })
  await Promise.all([webhook([request]), webhook([request])])
  expect(infer).toHaveBeenCalledTimes(quoted ? 1 : 2)
  expect(lastReply()).toContain('🔔 通知を追加しました\n\n英検申し込み\n期限：12月14日（土）\n通知：14日前・7日前・前日 20:00')
  const [added] = (await taskRows()).results
  expect(JSON.parse(String(added.reminder_rule))).toEqual({ type: 'offsets', slots: [fourteenth, seventh, eve] })
  expect(added).toMatchObject({ reminder_version: 2, next_reminder_at: Date.parse('2030-11-30T20:00:00+09:00') })
  const again = await command('前日にも知らせて', edit({ mode: 'add', slots: [eve] }))
  expect(again).toContain('その通知はすでに設定されています')
  expect((await taskRows()).results).toEqual([added])

  await command('7日前はいらない', edit({ mode: 'remove', slot: { daysBefore: 7 } }))
  expect(JSON.parse(String((await taskRows()).results[0].reminder_rule))).toEqual({ type: 'offsets', slots: [fourteenth, eve] })
  await command('やっぱ前日だけでいいや', edit({ mode: 'replace', rule: { type: 'offsets', slots: [eve] } }))
  expect((await taskRows()).results[0]).toMatchObject({ reminder_enabled: 1, next_reminder_at: Date.parse('2030-12-13T20:00:00+09:00') })
  await command('前日の通知は消して', edit({ mode: 'remove', slot: { daysBefore: 1 } }))
  expect((await taskRows()).results[0]).toMatchObject({ reminder_enabled: 0, next_reminder_at: null })
}, 15_000)

test('a retained slot keeps its body and Retry Key after adding another notification', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(conversationNow)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await command('12/14までに英検申し込み', application)
  const env = { ...platform.env, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' }
  const slot = Date.parse('2030-12-07T20:00:00+09:00')
  line.mockResolvedValueOnce(new Response(null, { status: 500 }))
  await runReminders(env, () => slot)
  const original = pushes()[0]
  vi.spyOn(Date, 'now').mockReturnValue(slot + 60_000)
  await command('英検、当日も通知して', edit({ mode: 'add', slots: [{ daysBefore: 0, time: '20:00' }] }, byName('英検')),
    { timestamp: slot + 60_000 })
  await runReminders(env, () => slot + 5 * 60_000)
  expect(pushes()).toEqual([original, original])
  expect(await env.DB.prepare('SELECT status, attempt_count, rule_version FROM reminder_occurrences').first())
    .toMatchObject({ status: 'sent', attempt_count: 2, rule_version: 2 })
})

test('keeps conversation and quotes to other groups or users away from inference', async () => {
  line.mockResolvedValueOnce(new Response('{"sentMessages":[{"id":"4444"}]}'))
  await command('英検を登録', application)
  line.mockClear()
  infer.mockClear()
  const inputs = [event('家族の会話'), event('通知もういらない', { quote: '5555' }),
    event('前日も通知して', { quote: '4444', groupId: 'group-b' })]
  await webhook(inputs)
  expect(line).not.toHaveBeenCalled()
  expect(infer).not.toHaveBeenCalled()
  for (const input of inputs) expect(await inbox(input.webhookEventId)).toBeNull()
})

test('uses the quote for deadline updates and stops, but rejects an explicitly different task', async () => {
  line.mockResolvedValueOnce(new Response('{"sentMessages":[{"id":"7777"}]}'))
  await command('英検を登録', application)
  await command('水筒を登録', { ...application, title: '水筒', category: 'belonging' })
  infer.mockResolvedValueOnce({ response: { type: 'disable_reminder', target: byName('水筒') } })
  await webhook([event('水筒の通知もういらない', { quote: '7777' })])
  expect(lastReply()).toContain('引用したタスクと本文のタスク名が異なります')
  expect((await taskRows()).results.map((row) => row.reminder_enabled)).toEqual([1, 1])
  infer.mockResolvedValueOnce({ response: { type: 'update_task', target: recent, dueDate: '2030-12-15' } })
  await webhook([event('この申し込みは15日までにして', { quote: '7777' })])
  expect((await taskRows()).results.map((row) => row.due_date)).toEqual(['2030-12-15', '2030-12-14'])
  infer.mockResolvedValueOnce({ response: { type: 'disable_reminder', target: recent } })
  await webhook([event('通知もういらない', { quote: '7777' })])
  expect((await taskRows()).results.map((row) => row.reminder_enabled)).toEqual([0, 1])
})

test('does not guess a task from a list reply or a name shared by several tasks', async () => {
  await command('英検を登録', application)
  await command('英検の別の申し込み', { ...application, title: '英検の2次申し込み' })
  line.mockResolvedValueOnce(new Response('{"sentMessages":[{"id":"8888"}]}'))
  await command('一覧を教えて', { type: 'list_tasks' })
  infer.mockResolvedValueOnce({ response: { type: 'complete_task', target: recent } })
  await webhook([event('これ終わった', { quote: '8888' })])
  expect(lastReply()).toContain('どのタスクのことですか？')
  expect((await taskRows()).results.map((row) => row.status)).toEqual(['open', 'open'])
  infer.mockResolvedValueOnce({ response: { type: 'complete_task', target: byName('英検の2次申し込み') } })
  await webhook([event('英検申し込み')])
  expect((await taskRows()).results.map((row) => row.status)).toEqual(['done', 'open'])
  expect(await command('英検のやつっていつ通知される？', { type: 'get_reminder', target: byName('英検') })).toContain('選択用の番号')
}, 15_000)

test('asks only for a missing time and continues on the same sender’s answer', async () => {
  await command('英検を登録', application)
  expect(await command('全部もうちょっと早めに通知して', { type: 'clarify', question: 'time' })).toBe('🔔 何時に通知しましょうか？')
  const earlier = infer.mock.calls.length
  await webhook([event('18時で', { userId: 'user-b' }), event('家族の会話')])
  expect(infer).toHaveBeenCalledTimes(earlier)
  infer.mockResolvedValueOnce({ response: edit({ mode: 'change_time', time: '18:00' }) })
  await webhook([event('18時で')])
  expect(infer.mock.lastCall?.[1]).toMatchObject({ messages: [expect.anything(), expect.anything(),
    { role: 'user', content: '全部もうちょっと早めに通知して\n補足：18時で' }] })
  expect(lastReply()).toContain('通知：7日前・前日 18:00')
  expect((await taskRows()).results[0].next_reminder_at).toBe(Date.parse('2030-12-07T18:00:00+09:00'))
  await webhook([event('17時で')])
  expect(infer).toHaveBeenCalledTimes(earlier + 1)
})

test('asking about a mode leaves the rule untouched until the same user answers', async () => {
  await command('英検を登録', application)
  const [before] = (await taskRows()).results
  expect(await command('3日前に通知して', { type: 'clarify', question: 'mode' }))
    .toBe('🔔 今の通知に追加しますか？\nそれとも置き換えますか？')
  expect((await taskRows()).results).toEqual([before])
  const additional = { daysBefore: 3, time: '20:00' }
  infer.mockResolvedValueOnce({ response: edit({ mode: 'add', slots: [additional] }) })
  await webhook([event('追加で')])
  expect(JSON.parse(String((await taskRows()).results[0].reminder_rule)))
    .toEqual({ type: 'offsets', slots: [seventh, additional, eve] })
}, 15_000)

test('resolves a conversational spelling of a task name and changes only the notification time', async () => {
  await command('英検を登録', application)
  const found = await command('英検の申し込むやつっていつ通知される？', { type: 'get_reminder', target: byName('英検申し込み') })
  expect(found).toContain('英検申し込み\n期限：12月14日（土）')
  await command('通知を全部21時にして', edit({ mode: 'change_time', time: '21:00' }))
  const [task] = (await taskRows()).results
  expect(JSON.parse(String(task.reminder_rule))).toEqual({ type: 'offsets',
    slots: [{ ...seventh, time: '21:00' }, { ...eve, time: '21:00' }] })
})

test('can quote a result delivered by Push after the Reply window', async () => {
  const request = await queueCreate()
  infer.mockResolvedValueOnce({ response: create })
  line.mockResolvedValueOnce(new Response('{"sentMessages":[{"id":928002345678901234}]}'))
  await tick(now + 60_000)
  expect(await result(request.webhookEventId)).toMatchObject({ channel: 'push', line_message_id: '928002345678901234' })
  await webhook([event('もう終わった', { quote: '928002345678901234' })])
  expect((await taskRows()).results[0]).toMatchObject({ status: 'done', next_reminder_at: null })
  expect(infer).toHaveBeenCalledTimes(1)
})

const calendarNow = Date.parse('2026-11-15T10:00:00+09:00')
const calendarTask = { ...application, dueDate: '2026-12-14' }
const plan = (...edits: import('../src/tasks/notification-plan').NotificationEdit[]) => ({ type: 'edit_notifications', target: recent, edits })
const relativeDate = (daysBefore: number, time?: string) => ({ kind: 'relative' as const, daysBefore, time })
const absoluteDate = (date: string, time: string) => ({ kind: 'absolute' as const, date, time })
const atTime = (time: string) => ({ kind: 'time' as const, time })

test('reproduces the device conversation and corrects the calendar date atomically in D1', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(calendarNow)
  await command('12/14までに英検申し込み', calendarTask)
  const rule = async () => JSON.parse(String((await taskRows()).results[0].reminder_rule))
  expect(await rule()).toEqual({ type: 'default' })
  await webhook([event('2週間前くらいから毎週通知して', { mention: true })])
  expect(await rule()).toMatchObject({ type: 'repeat', startDaysBefore: 14, everyDays: 7, times: ['20:00'], extraSlots: [seventh, eve] })
  const existing = (await taskRows()).results[0]
  expect(await command('前日にも通知して', plan({ op: 'add', when: relativeDate(1) }))).toContain('すでに設定')
  expect(await command('8時じゃなくて9時に通知して', plan({ op: 'move', selector: atTime('08:00'), to: atTime('09:00') })))
    .toContain('08:00の通知が見つかりません')
  expect((await taskRows()).results[0]).toEqual(existing)
  await command('3週間前にも通知して', plan({ op: 'add', when: relativeDate(21) }))
  expect((await rule()).extraSlots).toContainEqual({ daysBefore: 21, time: '20:00' })

  const calendar = { op: 'add' as const, when: absoluteDate('2026-11-16', '00:35') }
  const desired = (await taskRows()).results[0]
  expect(await command('英検の通知に11/16 0:35にも通知して',
    plan({ op: 'add', when: relativeDate(0, '00:35') }))).toContain('何日前')
  expect((await taskRows()).results[0]).toEqual(desired)
  await webhook([event('11/16 0:35にも通知して', { mention: true })])
  expect(await rule()).toMatchObject({ absoluteSlots: [{ date: '2026-11-16', time: '00:35' }] })
  expect((await rule()).extraSlots).not.toContainEqual({ daysBefore: 0, time: '00:35' })
  await command('当日の0:35にも通知して', plan({ op: 'add', when: relativeDate(0, '00:35') }))
  const prior = (await taskRows()).results[0]
  const exactCorrection = '当日の0:35は消して、11月16日の0:35にして'
  const request = event(exactCorrection, { mention: true })
  infer.mockResolvedValueOnce({ response: plan({ op: 'remove', selector: relativeDate(0, '00:35') }, calendar) })
  await Promise.all([webhook([request]), webhook([request])])
  expect((await rule()).extraSlots).toEqual([{ daysBefore: 21, time: '20:00' }, seventh, eve])
  expect((await rule()).absoluteSlots).toEqual([{ date: '2026-11-16', time: '00:35' }])
  expect((await taskRows()).results[0]).toMatchObject({ reminder_version: Number(prior.reminder_version) + 1,
    next_reminder_at: Date.parse('2026-11-16T00:35:00+09:00') })
  const corrected = (await taskRows()).results[0]
  expect(await command('7日前の通知は消して、11/14 0:35にも通知して', plan({ op: 'remove', selector: relativeDate(7) },
    { op: 'add', when: absoluteDate('2026-11-14', '00:35') }))).toContain('過ぎた日時')
  expect((await taskRows()).results[0]).toEqual(corrected)
  expect(await command('さっきの期限を12月15日にして', { type: 'update_task', target: recent, dueDate: '2026-12-15' })).toContain('変更しました')
  expect((await rule()).absoluteSlots).toEqual([{ date: '2026-11-16', time: '00:35' }])
}, 25_000)

test('passes scoped live state and recent operations, inherits a changed clock, and expires conversation', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(calendarNow)
  const setup = { ...calendarTask, rule: { type: 'offsets', slots: [
    { daysBefore: 7, time: '08:00' }, { daysBefore: 1, time: '20:00' },
  ] } }
  await command('英検を登録', setup)
  await command('8時じゃなくて9時に通知して', plan({ op: 'move', selector: atTime('08:00'), to: atTime('09:00') }))
  expect(lastReply()).toContain('変更：7日前 08:00 → 7日前 09:00')
  await command('3週間前にも通知して', plan({ op: 'add', when: relativeDate(21) }))
  const aiCall = infer.mock.lastCall?.[1] as { messages: { content: string }[] }
  expect(aiCall.messages.at(-2)?.content).toContain('"version":2')
  expect(aiCall.messages.at(-2)?.content).toContain('"recentConversation"')
  expect(aiCall.messages.at(-2)?.content).toContain('"upcoming"')
  const { DB } = platform.env
  const turn = await DB.prepare("SELECT turn_json FROM task_conversation WHERE json_extract(turn_json,'$.request') = ?")
    .bind('3週間前にも通知して').first<string>('turn_json')
  expect(JSON.parse(turn ?? '{}')).toMatchObject({ changes: [{ after: relativeDate(21, '09:00'), timeSource: 'conversation' }] })

  // Another user changes the latest D1 version. The first user's old focus cannot be used.
  await command('英検の通知を全部20時にして', { ...plan({ op: 'set_clock', time: '20:00' }), target: byName('英検') }, { userId: 'user-b' })
  const latest = (await taskRows()).results[0]
  expect(await command('さっき追加した通知はいらない', plan({ op: 'remove', selector: { kind: 'recent' } })))
    .toContain('見つかりません')
  expect((await taskRows()).results[0]).toEqual(latest)
  await command('英検はどんな通知？', { type: 'get_reminder', target: byName('英検') }, { userId: 'user-c' })
  const other = infer.mock.lastCall?.[1] as { messages: { content: string }[] }
  expect(other.messages.at(-2)?.content).not.toContain('"recentConversation"')
  const records = await DB.prepare("SELECT COUNT(*) AS count FROM task_conversation WHERE group_id = ? AND user_id = 'user-a'")
    .bind(group).first<number>('count')
  expect(records).toBeLessThanOrEqual(5)
  vi.mocked(Date.now).mockReturnValue(calendarNow + 46 * 60_000)
  await worker.scheduled({ cron: '* * * * *' } as ScheduledController, webhookEnv())
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM task_conversation').first<number>('count')).toBe(0)
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM task_contexts').first<number>('count')).toBe(0)
}, 25_000)

test('rejects an edit when the D1 version changes during inference', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(calendarNow)
  await command('英検を登録', calendarTask)
  const latestRule = { type: 'offsets', slots: [{ daysBefore: 1, time: '10:00' }] }
  infer.mockImplementationOnce(async () => {
    await platform.env.DB.prepare('UPDATE tasks SET reminder_rule = ?, reminder_version = 2 WHERE group_id = ?')
      .bind(JSON.stringify(latestRule), group).run()
    return { response: plan({ op: 'add', when: relativeDate(3, '18:00') }) }
  })
  await webhook([event('3日前の18時にも通知して', { mention: true })])
  expect(lastReply()).toContain('通知設定が先に変更されました')
  expect((await taskRows()).results[0]).toMatchObject({ reminder_rule: JSON.stringify(latestRule), reminder_version: 2 })
})
