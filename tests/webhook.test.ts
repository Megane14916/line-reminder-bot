import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery, type PlatformProxy } from 'wrangler'
import migration from '../migrations/0001_init.sql?raw'
import { app } from '../src/index'

// LINE's published signature verification example.
const bindings = {
  LINE_CHANNEL_SECRET: '8c570fa6dd201bb328f1c1eac23a96d8',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
}
const exampleBody = '{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}'
const exampleSignature = 'GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs='

let platform: PlatformProxy<Env>
beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ persist: false, remoteBindings: false, envFiles: [] })
  await platform.env.DB.batch(unstable_splitSqlQuery(migration).map((sql) => platform.env.DB.prepare(sql)))
}, 20_000)
afterAll(async () => await platform?.dispose())

const source = { type: 'group', groupId: 'test-group', userId: 'test-user' }
const mentionEvent = {
  type: 'message',
  mode: 'active',
  source,
  replyToken: 'test-reply-token',
  message: {
    type: 'text',
    text: '@家族Bot',
    mention: { mentionees: [{ isSelf: true, index: 0, length: 6, type: 'user' }] },
  },
}
const postbackEvent = { type: 'postback', mode: 'active', source, replyToken: 'test-postback-token' }

function post(body: string, signature?: string, waitUntil = vi.fn()) {
  return app.request('/webhook/line', {
    method: 'POST',
    headers: signature ? { 'x-line-signature': signature } : {},
    body,
  }, { ...bindings, DB: platform.env.DB }, { waitUntil, passThroughOnException: vi.fn(), props: {} })
}

async function sign(body: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(bindings.LINE_CHANNEL_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

async function postEvents(events: unknown[]) {
  const body = JSON.stringify({ events: events.map((event) => ({
    webhookEventId: crypto.randomUUID(), timestamp: Date.now(), ...event as object,
  })) })
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
  const response = await post(body, await sign(body), waitUntil)
  await Promise.all(waitUntil.mock.calls.map(([promise]) => promise))
  return response
}

function mockReply() {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('accepts a signed empty webhook', async () => {
  const response = await post(exampleBody, exampleSignature)

  expect(response.status).toBe(200)
})

test.each([
  ['a missing signature', exampleBody, undefined],
  ['malformed base64', exampleBody, 'invalid!'],
  ['a tampered body', `${exampleBody}\n`, exampleSignature],
  ['unsigned malformed JSON', '{', exampleSignature],
])('returns 401 for %s', async (_description, body, signature) => {
  const response = await post(body, signature)

  expect(response.status).toBe(401)
})

test.each(['{', '{"events":{}}'])('returns 400 for a signed invalid payload %s', async (body) => {
  const response = await post(body, await sign(body))

  expect(response.status).toBe(400)
})

test.each(['@家族Bot  ', '@家族Bot 明日の持ち物を教えて'])('replies with the Flex menu for %s', async (text) => {
  const fetchMock = mockReply()

  const response = await postEvents([{ ...mentionEvent, message: { ...mentionEvent.message, text } }])

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, request] = fetchMock.mock.calls[0]
  expect(url).toBe('https://api.line.me/v2/bot/message/reply')
  expect(request?.method).toBe('POST')
  const headers = new Headers(request?.headers)
  expect(headers.get('Authorization')).toBe('Bearer test-access-token')
  expect(headers.get('Content-Type')).toBe('application/json')
  expect(headers.has('X-Line-Retry-Key')).toBe(false)
  expect(JSON.parse(String(request?.body))).toMatchObject({
    replyToken: 'test-reply-token',
    messages: [{
      type: 'flex',
      altText: '家族Botの操作メニュー',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'button', action: { type: 'postback', label: '期限を追加', data: 'add_deadline' } },
            { type: 'button', action: { type: 'postback', label: '持ち物を追加', data: 'add_belonging' } },
            { type: 'button', action: { type: 'postback', label: '一覧を見る', data: 'list_tasks' } },
            { type: 'button', action: { type: 'postback', label: '使い方', data: 'help' } },
          ],
        },
      },
    }],
  })
})

test.each([
  ['add_deadline', '日付とタイトルを送ってください。'],
  ['add_belonging', '日付とタイトルを送ってください。'],
  ['list_tasks', '未完了のタスクはありません。'],
  ['help', '操作メニューを開きます。'],
])('replies to the %s postback', async (data, expectedText) => {
  const fetchMock = mockReply()

  const response = await postEvents([{ ...postbackEvent, source: { ...source, userId: data }, postback: { data } }])

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    replyToken: 'test-postback-token',
    messages: [{ type: 'text', text: expect.stringContaining(expectedText) }],
  })
})

test.each([
  ['ordinary chat', { ...mentionEvent, message: { type: 'text', text: 'おかえり' } }],
  ['the bot name as plain text', { ...mentionEvent, message: { type: 'text', text: '@家族Bot' } }],
  ['another user mention', { ...mentionEvent, message: { ...mentionEvent.message, mention: { mentionees: [{ isSelf: false }] } } }],
  ['an image', { ...mentionEvent, message: { type: 'image' } }],
  ['a direct message', { ...mentionEvent, source: { type: 'user', userId: 'test-user' } }],
  ['standby mode', { ...mentionEvent, mode: 'standby' }],
  ['a missing reply token', { ...mentionEvent, replyToken: undefined }],
  ['an unknown postback action', { ...postbackEvent, postback: { data: 'unknown' } }],
  ['extra postback data', { ...postbackEvent, postback: { data: 'help&taskId=1' } }],
  ['a postback outside a group', { ...postbackEvent, source: { type: 'room', userId: 'test-user' }, postback: { data: 'help' } }],
  ['a postback missing a group ID', { ...postbackEvent, source: { ...source, groupId: '' }, postback: { data: 'help' } }],
  ['a postback missing a sender', { ...postbackEvent, source: { ...source, userId: undefined }, postback: { data: 'help' } }],
])('ignores %s', async (_description, event) => {
  const fetchMock = mockReply()

  const response = await postEvents([event])

  expect(response.status).toBe(200)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('acknowledges a batch and settles all replies when some fail', async () => {
  const fetchMock = mockReply()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let finishFirstReply!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishFirstReply = resolve }))
  fetchMock.mockRejectedValueOnce(new Error('private network error detail'))
  const body = JSON.stringify({ events: [
    { ...mentionEvent, webhookEventId: 'http-failure' },
    { ...postbackEvent, postback: { data: 'help' }, webhookEventId: 'network-failure' },
    { ...mentionEvent, replyToken: 'another-reply-token', webhookEventId: 'success' },
  ] })
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()

  const response = await post(body, await sign(body), waitUntil)
  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(waitUntil).toHaveBeenCalledTimes(1)

  finishFirstReply(new Response(null, { status: 500 }))
  await expect(waitUntil.mock.calls[0][0]).resolves.toEqual([undefined, undefined, undefined])
  expect(log.mock.calls).toEqual([
    ['LINE reply failed', { action: 'help', eventId: 'network-failure', kind: 'network' }],
    ['LINE reply failed', { action: 'menu', eventId: 'http-failure', kind: 'http', status: 500 }],
  ])
})

test('keeps a committed task and does not retry its failed reply on redelivery', async () => {
  const fetchMock = mockReply()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const taskSource = { ...source, groupId: 'reply-failure' }

  await postEvents([{ ...postbackEvent, source: taskSource, postback: { data: 'add_deadline' } }])
  await postEvents([{ ...mentionEvent, source: taskSource, message: { type: 'text', text: '2099-11-20 遠足' } }])
  const confirmation = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)).messages[0]
  const data = confirmation.contents.body.contents[1].action.data
  const event = { ...postbackEvent, source: taskSource, postback: { data }, webhookEventId: 'failed-confirm-reply' }

  fetchMock.mockClear().mockResolvedValueOnce(new Response(null, { status: 400 }))
  expect((await postEvents([event])).status).toBe(200)
  expect((await postEvents([event])).status).toBe(200)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(log.mock.calls).toEqual([
    ['LINE reply failed', { action: 'confirm', eventId: 'failed-confirm-reply', kind: 'http', status: 400 }],
  ])
  expect(await platform.env.DB.prepare('SELECT COUNT(*) AS total FROM tasks WHERE group_id = ?')
    .bind(taskSource.groupId).first('total')).toBe(1)
})

test('ignores chat during input, keeps the session and replies to date-like errors', async () => {
  const fetchMock = mockReply()
  const taskSource = { ...source, groupId: 'input-filter' }
  const message = (text: string, userId = taskSource.userId) => ({
    ...mentionEvent, source: { ...taskSource, userId }, message: { type: 'text', text },
  })
  const lastReply = () => JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)).messages[0]
  await postEvents([{ ...postbackEvent, source: taskSource, postback: { data: 'add_deadline' } }])

  const session = () => platform.env.DB.prepare('SELECT * FROM interaction_sessions WHERE group_id = ? AND user_id = ?')
    .bind(taskSource.groupId, taskSource.userId).first()
  const waiting = await session()
  expect(waiting).toMatchObject({ state: 'awaiting_input' })

  fetchMock.mockClear()
  await postEvents([message('今日の晩ご飯何？'), message('今日の晩ご飯何？', 'someone-else'),
    message('2099-11-20 遠足', 'someone-else')])
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await session()).toEqual(waiting)

  await postEvents([{ ...mentionEvent, source: taskSource }])
  expect(lastReply()).toMatchObject({ type: 'flex', altText: '家族Botの操作メニュー' })

  for (const input of ['11/31 遠足', '11/20', `11/20 ${'あ'.repeat(101)}`]) {
    await postEvents([message(input)])
    expect(lastReply()).toMatchObject({ type: 'text', text: expect.stringContaining('日付またはタイトルを確認') })
  }
  expect(await session()).toEqual(waiting)

  await postEvents([message('2099-11-20 遠足')])
  expect(lastReply()).toMatchObject({ type: 'flex', altText: '登録の確認' })
})

test('runs the group task flow through signed webhooks and LINE postbacks', async () => {
  const fetchMock = mockReply()
  const taskSource = { ...source, groupId: 'task-flow' }
  const text = (value: string, userId = taskSource.userId) => ({
    ...mentionEvent, source: { ...taskSource, userId }, message: { type: 'text', text: value },
  })
  const press = (data: string, webhookEventId = crypto.randomUUID()) => ({
    ...postbackEvent, source: taskSource, postback: { data }, webhookEventId,
  })
  const messages = () => JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)).messages
  const date = '2099-11-20'

  await postEvents([press('add_deadline')])
  expect(messages()[0].text).toContain('日付とタイトル')
  fetchMock.mockClear()
  await postEvents([text(`${date} 遠足の同意書`, 'someone-else')])
  expect(fetchMock).not.toHaveBeenCalled()

  await postEvents([text(`${date} 遠足の同意書`)])
  const create = messages()[0].contents.body.contents[1].action.data
  const buttonEvent = press(create)
  await postEvents([buttonEvent])
  expect(messages()[0].text).toContain('登録しました')
  fetchMock.mockClear()
  await postEvents([buttonEvent])
  expect(fetchMock).not.toHaveBeenCalled()

  await postEvents([press('add_belonging'), text(`${date} 水筒`)])
  const addBelonging = messages()[0].contents.body.contents[1].action.data
  await postEvents([press(addBelonging)])
  await postEvents([press('list_tasks')])
  const list = messages()[0].contents.contents
  expect(list).toHaveLength(2)
  expect(list[0].body.contents[0].text).toContain('遠足の同意書')
  expect(list[1].body.contents[0].text).toContain('水筒')

  await postEvents([press(list[0].body.contents[1].action.data)])
  expect(messages()[0].text).toContain('完了しました')
  await postEvents([press(list[1].body.contents[2].action.data)])
  expect(messages()[0].altText).toBe('削除の確認')
  const remove = messages()[0].contents.body.contents[1].action.data
  await postEvents([press('list_tasks')])
  expect(messages()[0].contents.contents).toHaveLength(1)
  await postEvents([press(remove)])
  expect(messages()[0].text).toContain('削除しました')
  await postEvents([press('list_tasks')])
  expect(messages()[0].text).toContain('未完了のタスクはありません')
})

test('returns a retryable response when D1 fails to process an event', async () => {
  const fetchMock = mockReply()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const body = JSON.stringify({ events: [{
    ...postbackEvent, postback: { data: 'add_deadline' }, webhookEventId: 'retryable', timestamp: Date.now(),
    source: { ...source, groupId: 'simulate-db-failure' },
  }] })
  const db = platform.env.DB
  await db.prepare(`CREATE TRIGGER fail_session_insert BEFORE INSERT ON interaction_sessions
    WHEN NEW.group_id = 'simulate-db-failure' BEGIN SELECT RAISE(ABORT, 'test D1 error'); END`).run()

  const response = await post(body, await sign(body))

  expect(response.status).toBe(503)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith('LINE task action failed', 'start_create')
  expect(await db.prepare('SELECT event_id FROM processed_events WHERE event_id = ?').bind('retryable').first())
    .toBeNull()
})
