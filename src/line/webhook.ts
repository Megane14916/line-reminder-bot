import { Hono } from 'hono'

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

  if (typeof payload !== 'object' || payload === null ||
      !('events' in payload) || !Array.isArray(payload.events)) {
    return c.text('Bad Request', 400)
  }

  return c.body(null, 200)
})

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
