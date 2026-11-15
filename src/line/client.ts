import { isLosslessNumber, parse } from 'lossless-json'
import { defaultLineTimeout } from '../runtime-budget'

export type SendResult =
  | { ok: true; messageId?: string }
  | { ok: false; kind: 'http'; status: number; retryAfter?: string }
  | { ok: false; kind: 'network' | 'timeout' }

export const pushTimeoutMs = defaultLineTimeout

export function sendReply(accessToken: string, replyToken: string, text: string, timeoutMs = pushTimeoutMs) {
  return postMessage('reply', accessToken, JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }), undefined, timeoutMs)
}

export function sendPush(accessToken: string, groupId: string, text: string, retryKey: string, timeoutMs = pushTimeoutMs) {
  const body = JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] })
  return postMessage('push', accessToken, body, retryKey, timeoutMs)
}

async function postMessage(endpoint: 'reply' | 'push', accessToken: string, body: string, retryKey?: string,
  timeoutMs = pushTimeoutMs): Promise<SendResult> {
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
    const messageId = await readMessageId(response, signal)
    return messageId ? { ok: true, messageId } : { ok: true }
  }
  const retryAfter = response.status === 429 ? response.headers.get('Retry-After') : null
  return { ok: false, kind: 'http', status: response.status, ...(retryAfter ? { retryAfter } : {}) }
}

export function retryDelay(result: Extract<SendResult, { ok: false }>, now: number, delay: number) {
  if (result.kind !== 'http' || (result.status >= 500 && result.status < 600)) return delay
  if (result.status !== 429) return null
  const after = result.retryAfter?.trim() ?? ''
  const requested = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now
  return Math.max(delay, 15 * 60_000, Number.isNaN(requested) ? 0 : requested)
}

async function readMessageId(response: Response, signal: AbortSignal) {
  if (signal.aborted) return
  let onAbort: () => void = () => {}
  try {
    const aborted = new Promise<string>((resolve) => {
      onAbort = () => resolve('')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const payload = parse(await Promise.race([response.text(), aborted])) as { sentMessages?: { id?: unknown }[] }
    const id = Array.isArray(payload?.sentMessages) ? payload.sentMessages[0]?.id : undefined
    const value = isLosslessNumber(id) ? id.toString() : id
    if (typeof value === 'string' && /^\d+$/.test(value)) return value
  } catch {
    // An accepted response can omit message IDs, including during recovery.
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
