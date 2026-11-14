import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { app } from '../src/index'
import { parseIntent } from '../src/line/intent-parser'
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
  await DB.batch(['reminder_occurrences', 'tasks', 'task_contexts', 'processed_events', 'group_reminder_defaults']
    .map((table) => DB.prepare('DELETE FROM ' + table)))
  vi.spyOn(Date, 'now').mockReturnValue(now)
  infer.mockReset()
  line.mockReset().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', line)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function webhook(events: unknown[], options: { raw?: string; tampered?: boolean; missing?: boolean } = {}) {
  const body = options.raw ?? JSON.stringify({ events })
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))
  const work: Promise<unknown>[] = []
  const response = await app.request('/webhook/line', {
    method: 'POST', body: options.tampered ? body + '\\n' : body,
    headers: options.missing ? {} : { 'x-line-signature': signature },
  }, { ...platform.env, LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: 'test-token', AI: ai, AI_MODEL: model },
  { waitUntil: (promise) => { work.push(promise) }, passThroughOnException: vi.fn(), props: {} })
  await Promise.all(work)
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
  await command('テスト', action)
  expect((await taskRows()).results).toEqual([])
  expect(lastReply()).toMatch(/読み取れ|過去/)
})

test('handles inference timeouts and transport failures without an action', async () => {
  infer.mockImplementationOnce(() => new Promise(() => {}))
  await expect(parseIntent(ai, model, '今日の締切', now, 5)).resolves.toBeUndefined()
  infer.mockRejectedValueOnce(new Error('network failed'))
  await webhook([event('今日の締切', { mention: true })])
  expect(lastReply()).toContain('読み取れません')
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
