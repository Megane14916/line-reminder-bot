import { Hono } from 'hono'
import { dispatchAction, type TaskAction } from '../tasks/actions'
import { sendReply } from './client'
import { createActionMessages, createMenuMessage, helpMessage, parsePostback, type ReplyMessage } from './messages'

export const lineWebhook = new Hono<{ Bindings: Env }>()

lineWebhook.post('/', async (c) => {
  const signature = c.req.header('x-line-signature')
  if (!signature) return c.text('Unauthorized', 401)

  const secret = c.env?.LINE_CHANNEL_SECRET
  if (!secret) {
    console.error('LINE channel secret is not configured')
    return c.text('Service Unavailable', 503)
  }

  const body = await c.req.arrayBuffer()
  if (!await verifySignature(secret, signature, body)) {
    return c.text('Unauthorized', 401)
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return c.text('Bad Request', 400)
  }

  if (!isRecord(payload) || !Array.isArray(payload.events)) return c.text('Bad Request', 400)

  const events = payload.events.flatMap((event: unknown) => {
    const operation = getOperation(event)
    return operation ? [operation] : []
  })
  if (!events.length) return c.body(null, 200)

  const { DB, LINE_CHANNEL_ACCESS_TOKEN: accessToken } = c.env
  if (!accessToken) {
    console.error('LINE channel access token is not configured')
    return c.text('Service Unavailable', 503)
  }

  const replies: Promise<void>[] = []
  let failed = false
  for (const event of events) {
    try {
      const messages = await getMessages(DB, event)
      if (messages.length) replies.push(deliverReply(accessToken, event, messages))
    } catch {
      console.error('LINE task action failed', event.action.type)
      failed = true
      // Preserve the order of state transitions for events in this delivery.
      break
    }
  }

  if (replies.length) c.executionCtx.waitUntil(Promise.all(replies))
  if (failed) return c.text('Service Unavailable', 503)
  return c.body(null, 200)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

type Operation = {
  replyToken: string
  groupId: string
  userId: unknown
  eventId: unknown
  eventTime: unknown
  action: TaskAction | { type: 'menu' } | { type: 'help' }
}

async function deliverReply(accessToken: string, event: Operation, messages: ReplyMessage[]) {
  const context = {
    action: event.action.type,
    eventId: isNonEmptyString(event.eventId) ? event.eventId : undefined,
  }
  try {
    const result = await sendReply(accessToken, event.replyToken, messages)
    if (!result.ok) {
      const status = result.kind === 'http' ? { status: result.status } : {}
      console.error('LINE reply failed', { ...context, kind: result.kind, ...status })
    }
  } catch {
    console.error('LINE reply failed', { ...context, kind: 'unexpected' })
  }
}

function getOperation(event: unknown): Operation | undefined {
  if (!isRecord(event) || event.mode === 'standby' || !isNonEmptyString(event.replyToken)) return

  const { source, replyToken } = event
  if (!isRecord(source) || source.type !== 'group' || !isNonEmptyString(source.groupId)) return

  const context = { replyToken, groupId: source.groupId, userId: source.userId,
    eventId: event.webhookEventId, eventTime: event.timestamp }
  if (event.type === 'postback' && isNonEmptyString(source.userId) && isRecord(event.postback)) {
    const action = parsePostback(event.postback.data)
    if (action) return { ...context, action }
  }

  if (event.type === 'message' && isRecord(event.message) &&
      event.message.type === 'text' && typeof event.message.text === 'string') {
    const { mention } = event.message
    if (isRecord(mention) && Array.isArray(mention.mentionees) && mention.mentionees.length) {
      if (mention.mentionees.some((mentionee: unknown) => isRecord(mentionee) && mentionee.isSelf === true)) {
        return { ...context, action: { type: 'menu' } }
      }
      return
    }
    if (isNonEmptyString(source.userId)) return { ...context, action: { type: 'submit_input', text: event.message.text } }
  }
}

async function getMessages(db: D1Database, { action, groupId, userId, eventId, eventTime }: Operation) {
  if (action.type === 'menu') return [createMenuMessage()]
  if (action.type === 'help') return [helpMessage]
  if (!isNonEmptyString(userId) || !isNonEmptyString(eventId) ||
      typeof eventTime !== 'number' || !Number.isSafeInteger(eventTime)) return []

  const result = await dispatchAction(db, { groupId, userId, eventId, eventTime, now: Date.now() }, action)
  return result ? createActionMessages(result) : []
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
