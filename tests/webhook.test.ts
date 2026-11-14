import { afterEach, expect, test, vi } from 'vitest'
import app from '../src/index'

// LINE's published signature verification example.
const bindings = {
  LINE_CHANNEL_SECRET: '8c570fa6dd201bb328f1c1eac23a96d8',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
}
const exampleBody = '{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}'
const exampleSignature = 'GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs='

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
  }, bindings, { waitUntil, passThroughOnException: vi.fn(), props: {} })
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
  const body = JSON.stringify({ events })
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
  expect(request).toMatchObject({
    method: 'POST',
    headers: { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
  })
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
  ['add_deadline', '期限の追加を選びました。'],
  ['add_belonging', '持ち物の追加を選びました。'],
  ['list_tasks', '一覧を選びました。'],
  ['help', '操作メニューが開きます。'],
])('replies to the %s postback', async (data, expectedText) => {
  const fetchMock = mockReply()

  const response = await postEvents([{ ...postbackEvent, postback: { data } }])

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

test('acknowledges a batch without waiting for Reply API responses', async () => {
  const fetchMock = mockReply()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let finishFirstReply!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishFirstReply = resolve }))
  const body = JSON.stringify({ events: [mentionEvent, { ...postbackEvent, postback: { data: 'help' } }] })
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()

  const response = await post(body, await sign(body), waitUntil)
  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(waitUntil).toHaveBeenCalledTimes(1)

  finishFirstReply(new Response(null, { status: 500 }))
  await waitUntil.mock.calls[0][0]
  expect(log).toHaveBeenCalledWith('LINE Reply API returned HTTP', 500)
})
