import type { ReplyMessage } from './messages'

type SendResult =
  | { ok: true }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network' }

export function sendReply(accessToken: string, replyToken: string, messages: ReplyMessage[]) {
  return postMessage('reply', accessToken, JSON.stringify({ replyToken, messages }))
}

export function sendPush(accessToken: string, groupId: string, text: string, retryKey: string) {
  const body = JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] })
  return postMessage('push', accessToken, body, retryKey)
}

async function postMessage(endpoint: 'reply' | 'push', accessToken: string, body: string, retryKey?: string): Promise<SendResult> {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  })
  if (retryKey) headers.set('X-Line-Retry-Key', retryKey)

  let response: Response
  try {
    response = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
      method: 'POST', headers, body,
      signal: endpoint === 'push' ? AbortSignal.timeout(10_000) : undefined,
    })
  } catch {
    return { ok: false, kind: 'network' }
  }
  if (response.ok || (retryKey && response.status === 409 && response.headers.has('X-Line-Accepted-Request-Id'))) {
    return { ok: true }
  }
  return { ok: false, kind: 'http', status: response.status }
}
