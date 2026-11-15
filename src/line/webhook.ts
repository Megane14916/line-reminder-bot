import { Hono } from 'hono'
import { acceptEvents, drainInbox, type Operation } from './inbox'
import { runtimeBudget, withinBudget } from '../runtime-budget'

export const lineWebhook = new Hono<{ Bindings: Env }>()

lineWebhook.post('/', async (c) => {
  const receivedAt = Date.now()
  const signature = c.req.header('x-line-signature')
  if (!signature) return c.text('Unauthorized', 401)
  const env = c.env
  const secret = env?.LINE_CHANNEL_SECRET
  if (!secret) return c.text('Service Unavailable', 503)
  const body = await c.req.arrayBuffer()
  if (!await verifySignature(secret, signature, body)) return c.text('Unauthorized', 401)

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return c.text('Bad Request', 400)
  }
  if (!isRecord(payload) || !Array.isArray(payload.events)) return c.text('Bad Request', 400)
  const operations = payload.events.map(getOperation).filter((operation): operation is Operation => !!operation)
  if (!operations.length) return c.body(null, 200)
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return c.text('Service Unavailable', 503)

  try {
    await acceptEvents(env.DB, operations, receivedAt)
  } catch {
    console.error('LINE inbox intake failed', { events: operations.length })
    return c.text('Service Unavailable', 503)
  }
  const budget = runtimeBudget()
  c.executionCtx.waitUntil(withinBudget(budget, () => drainInbox(env, budget)).catch(() => console.error('LINE inbox drain failed')))
  return c.body(null, 200)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function getOperation(event: unknown): Operation | undefined {
  if (!isRecord(event) || event.type !== 'message' || event.mode === 'standby') return
  const { source, replyToken, webhookEventId, timestamp, message } = event
  if (!isRecord(source) || source.type !== 'group' || !isNonEmptyString(source.groupId) || !isNonEmptyString(source.userId)
    || !isNonEmptyString(replyToken) || !isNonEmptyString(webhookEventId) || typeof timestamp !== 'number'
    || !Number.isSafeInteger(timestamp) || !isRecord(message) || message.type !== 'text' || typeof message.text !== 'string') return

  const context = { replyToken, groupId: source.groupId, userId: source.userId, eventId: webhookEventId, eventTime: timestamp }
  const { mention, quotedMessageId } = message
  const mentionees: unknown[] = isRecord(mention) && Array.isArray(mention.mentionees) ? mention.mentionees : []
  const self = mentionees.filter((entry) => isRecord(entry) && entry.isSelf === true)
  const text = stripMentions(message.text, self)
  if (text === undefined) return
  if (typeof quotedMessageId === 'string' && /^\d+$/.test(quotedMessageId)
    && /^(?:終わった|完了(?:した|しました)?|済(?:み)?|できた|✅)[。！!]*$/.test(text)) {
    return { ...context, input: { type: 'quote', messageId: quotedMessageId } }
  }
  const selection = /^#([1-9]\d{0,15})$/.exec(text)
  if (selection && Number.isSafeInteger(Number(selection[1]))) {
    return { ...context, input: { type: 'selection', id: Number(selection[1]) } }
  }
  if (self.length) return { ...context, input: { type: 'intent', text: text.slice(0, 2001) } }
}

function stripMentions(text: string, mentions: unknown[]) {
  const spans: { start: number; end: number }[] = []
  for (const mention of mentions) {
    if (!isRecord(mention) || typeof mention.index !== 'number' || typeof mention.length !== 'number'
      || !Number.isInteger(mention.index) || !Number.isInteger(mention.length) || mention.index < 0
      || mention.length < 1 || mention.index + mention.length > text.length || text[mention.index] !== '@') return
    spans.push({ start: mention.index, end: mention.index + mention.length })
  }
  let nextStart = text.length
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    if (end > nextStart) return
    text = text.slice(0, start) + ' ' + text.slice(end)
    nextStart = start
  }
  return text.trim()
}

async function verifySignature(secret: string, header: string, body: ArrayBuffer) {
  let signature: Uint8Array<ArrayBuffer>
  try {
    signature = Uint8Array.from(atob(header), (byte) => byte.charCodeAt(0))
  } catch {
    return false
  }
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, signature, body)
}
