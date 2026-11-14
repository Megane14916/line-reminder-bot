import { afterEach, expect, test, vi } from 'vitest'
import { sendPush, sendReply } from '../src/line/client'

const messages = 'テスト返信'

afterEach(() => vi.unstubAllGlobals())

test('reports success for a 200 reply', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })))

  await expect(sendReply('access-token', 'reply-token', messages)).resolves.toEqual({ ok: true })
})

test.each([400, 500])('reports HTTP %i as a reply failure', async (status) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })))

  await expect(sendReply('access-token', 'reply-token', messages)).resolves.toEqual({ ok: false, kind: 'http', status })
})

test('reports a rejected fetch as a network failure', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('Network unavailable')))

  await expect(sendReply('access-token', 'reply-token', messages)).resolves.toEqual({ ok: false, kind: 'network' })
})

test.each([200, 409])('preserves a large numeric message ID in a %i response', async (status) => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{"sentMessages":[{"id":987654321012345678}]}', {
    status, headers: { 'X-Line-Accepted-Request-Id': 'accepted' },
  })))
  await expect(sendPush('access', 'group', 'text', 'key')).resolves.toEqual({ ok: true, messageId: '987654321012345678' })
})

test('accepts a duplicate without inventing a message ID', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
    status: 409, headers: { 'X-Line-Accepted-Request-Id': 'accepted' },
  })))
  await expect(sendPush('access', 'group', 'text', 'key')).resolves.toEqual({ ok: true })
})
