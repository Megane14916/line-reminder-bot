import { afterEach, expect, test, vi } from 'vitest'
import { sendReply } from '../src/line/client'

const messages = [{ type: 'text' as const, text: 'テスト返信' }]

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
