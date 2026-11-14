import { Hono } from 'hono'
import { sendReply } from './client'
import { createMenuMessage, createPostbackMessage } from './messages'

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

  const replies = payload.events.flatMap((event: unknown) => {
    const reply = getReply(event)
    return reply ? [reply] : []
  })
  if (replies.length) {
    const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN
    if (!accessToken) {
      console.error('LINE channel access token is not configured')
      return c.text('Service Unavailable', 503)
    }

    c.executionCtx.waitUntil(Promise.all(replies.map(({ token, message }) =>
      sendReply(accessToken, token, message),
    )))
  }

  return c.body(null, 200)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function getReply(event: unknown) {
  if (!isRecord(event) || event.mode === 'standby' || !isNonEmptyString(event.replyToken)) return

  const { source, replyToken: token } = event
  if (!isRecord(source) || source.type !== 'group' || !isNonEmptyString(source.groupId)) return

  if (event.type === 'postback' && isNonEmptyString(source.userId) && isRecord(event.postback)) {
    const message = createPostbackMessage(event.postback.data)
    if (message) return { token, message }
  }

  if (event.type === 'message' && isRecord(event.message) &&
      event.message.type === 'text' && typeof event.message.text === 'string') {
    const { mention } = event.message
    if (isRecord(mention) && Array.isArray(mention.mentionees) &&
        mention.mentionees.some((mentionee: unknown) => isRecord(mentionee) && mentionee.isSelf === true)) {
      return { token, message: createMenuMessage() }
    }
  }
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
