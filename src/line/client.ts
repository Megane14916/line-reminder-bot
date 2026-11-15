import { isLosslessNumber, parse } from 'lossless-json'

type SendResult =
  | { ok: true; messageId?: string }
  | { ok: false; kind: 'http'; status: number; retryAfter?: string }
  | { ok: false; kind: 'network' | 'timeout' }

export const pushTimeoutMs = 10_000

export function sendReply(accessToken: string, replyToken: string, text: string, timeoutMs = pushTimeoutMs) {
  return postMessage('reply', accessToken, JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }), undefined, timeoutMs)
}

export function sendPush(accessToken: string, groupId: string, text: string, retryKey: string) {
  const body = JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] })
  return postMessage('push', accessToken, body, retryKey)
}

async function postMessage(endpoint: 'reply' | 'push', accessToken: string, body: string, retryKey?: string, timeoutMs = pushTimeoutMs): Promise<SendResult> {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  })
  if (retryKey) headers.set('X-Line-Retry-Key', retryKey)

  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
      method: 'POST', headers, body,
      signal,
    })
  } catch {
    return { ok: false, kind: signal?.aborted ? 'timeout' : 'network' }
  }
  if (response.ok || (retryKey && response.status === 409 && response.headers.has('X-Line-Accepted-Request-Id'))) {
    const messageId = endpoint === 'push' ? await readMessageId(response) : undefined
    return messageId ? { ok: true, messageId } : { ok: true }
  }
  const retryAfter = endpoint === 'push' && response.status === 429 ? response.headers.get('Retry-After') : null
  return { ok: false, kind: 'http', status: response.status, ...(retryAfter ? { retryAfter } : {}) }
}

async function readMessageId(response: Response) {
  try {
    const payload = parse(await response.text()) as { sentMessages?: { id?: unknown }[] }
    const id = Array.isArray(payload?.sentMessages) ? payload.sentMessages[0]?.id : undefined
    const value = isLosslessNumber(id) ? id.toString() : id
    if (typeof value === 'string' && /^\d+$/.test(value)) return value
  } catch {
    // An accepted response can omit message IDs, including during recovery.
  }
}
