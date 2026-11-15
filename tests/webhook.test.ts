import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import worker, { app } from '../src/index'
import { parseIntent } from '../src/line/intent-parser'
import { acceptEvents, drainInbox } from '../src/line/inbox'
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
  await DB.batch(['reminder_occurrences', 'tasks', 'task_contexts', 'processed_events', 'group_reminder_defaults',
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
})

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
    vi.mocked(Date.now).mockReturnValue(now + 12_500)
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
  expect(line).toHaveBeenCalledTimes(1)
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

function inbox(eventId: string) {
  return platform.env.DB.prepare('SELECT * FROM webhook_inbox WHERE event_id = ?').bind(eventId).first()
}

function tick(time: number) {
  vi.mocked(Date.now).mockReturnValue(time)
  return drainInbox(webhookEnv())
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
  expect(line).toHaveBeenCalledTimes(1)
  expect(infer).toHaveBeenCalledTimes(1)
  expect((await taskRows()).results).toHaveLength(1)
  expect(await inbox(request.webhookEventId)).toMatchObject({ status: 'succeeded', attempts: 1 })
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
  expect(line).not.toHaveBeenCalled()
  expect((await taskRows()).results).toEqual([])
})

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
  expect(lastReply()).toContain('Bot にメンションして')
  expect(infer).not.toHaveBeenCalled()
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
  expect(lastReply()).toContain('登録しました')
  expect((await taskRows()).results).toMatchObject([{ reminder_rule: JSON.stringify(rule), next_reminder_at: Date.parse('2030-12-13T20:00:00+09:00') }])
  expect(await command('12月の提出物', { type: 'list_tasks', from: '2030-12-01', to: '2030-12-31', category: 'deadline' })).toContain('レポート')
})

test('updates, completes, reopens, logically deletes, restores and manages notifications through recent context', async () => {
  await command('12月20日までにレポート提出', { type: 'create_task', title: 'レポート', category: 'deadline', dueDate: '2030-12-20' })
  expect(await command('レポートを作文に変えて12月23日締切', { type: 'update_task', target: byName('レポート'),
    title: '作文', dueDate: '2030-12-23' })).toContain('2030-12-23')
  expect(await command('やっぱり3日前と前日だけ', { type: 'set_reminder', target: recent, setting: { by: 'rule',
    rule: { type: 'offsets', slots: [{ daysBefore: 3, time: '20:00' }, { daysBefore: 1, time: '20:00' }] } } })).toContain('2030-12-20')
  expect(await command('通知時間を21時に変えて', { type: 'set_reminder', target: recent,
    setting: { by: 'time', time: '21:00' } })).toContain('21:00')
  expect(await command('このタスクはいつ通知？', { type: 'get_reminder', target: recent })).toContain('2030-12-22 21:00')
  await command('通知停止', { type: 'disable_reminder', target: recent })
  expect((await taskRows()).results[0].next_reminder_at).toBeNull()
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
})

test('keeps ambiguous selection scoped to the initiating user and group', async () => {
  for (const dueDate of ['2030-12-20', '2030-12-23']) {
    await command('水筒を登録', { type: 'create_task', title: '水筒', category: 'belonging', dueDate })
  }
  expect(await command('水筒完了', { type: 'complete_task', target: byName('水筒') })).toContain('どのタスク')
  const [first, second] = (await taskRows()).results
  const token = '#' + second.id
  await webhook([event(token, { userId: 'user-b' }), event(token, { groupId: 'group-b' })])
  expect((await taskRows()).results).toMatchObject([{ status: 'open' }, { status: 'open' }])
  await webhook([event(token)])
  expect((await taskRows()).results).toMatchObject([{ id: first.id, status: 'open' }, { id: second.id, status: 'done' }])
  expect(await command(token + '削除', { type: 'delete_task', target: { by: 'id', id: second.id } }, { groupId: 'group-b' })).toContain('見つかりません')
  expect(await command('やっぱり通知停止', { type: 'disable_reminder', target: recent }, { userId: 'user-b' })).toContain('見つかりません')
})

test('uses a group default only for subsequently registered tasks in that group', async () => {
  const task = { type: 'create_task', title: '提出物', category: 'deadline', dueDate: '2030-12-20' }
  await command('提出物登録', task)
  const rule = { type: 'offsets', slots: [{ daysBefore: 1, time: '21:00' }] }
  await command('今後登録するタスクは前日21時', { type: 'set_group_default', rule })
  await command('提出物登録', task)
  await command('提出物登録', task, { groupId: 'group-b' })
  expect((await taskRows()).results.map((row) => JSON.parse(String(row.reminder_rule)))).toEqual([{ type: 'default' }, rule, { type: 'default' }])
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
