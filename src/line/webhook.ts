import { Hono } from 'hono'
import { answerSelection, clarify, dispatchAction, help } from '../tasks/actions'
import { getQuotedTask, wasProcessed, type TaskEvent } from '../tasks/repository'
import { sendReply } from './client'
import { parseIntent } from './intent-parser'

export const lineWebhook = new Hono<{ Bindings: Env }>()

lineWebhook.post('/', async (c) => {
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

  // Acknowledge LINE promptly. Events from the same delivery are handled in order.
  c.executionCtx.waitUntil(processEvents(env, operations))
  return c.body(null, 200)
})

type Operation = TaskEvent & {
  replyToken: string
  input: { type: 'intent'; text: string } | { type: 'quote'; messageId: string } | { type: 'selection'; id: number }
}

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

  const context = { replyToken, groupId: source.groupId, userId: source.userId, eventId: webhookEventId, eventTime: timestamp, now: Date.now() }
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
  if (self.length) return { ...context, input: { type: 'intent', text } }
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

async function processEvents(env: Env, operations: Operation[]) {
  for (const event of operations) {
    let reply: string | undefined
    try {
      reply = await handleInput(env, event)
    } catch {
      console.error('LINE task action failed', { eventId: event.eventId, input: event.input.type })
      reply = '処理結果を確認できませんでした。タスク一覧で確認してください。'
    }
    if (reply) await deliverReply(env.LINE_CHANNEL_ACCESS_TOKEN, event, reply)
  }
}

async function deliverReply(accessToken: string, event: Operation, reply: string) {
  const context = { input: event.input.type, eventId: event.eventId }
  try {
    const result = await sendReply(accessToken, event.replyToken, reply)
    if (!result.ok) {
      const status = result.kind === 'http' ? { status: result.status } : {}
      console.error('LINE reply failed', { ...context, kind: result.kind, ...status })
    }
  } catch {
    console.error('LINE reply failed', { ...context, kind: 'unexpected' })
  }
}

async function handleInput({ DB, AI, AI_MODEL }: Env, event: Operation) {
  const { input } = event
  if (input.type === 'intent' && !input.text) return help
  if (await wasProcessed(DB, event.eventId)) return
  if (input.type === 'quote') {
    const id = await getQuotedTask(DB, event.groupId, input.messageId)
    if (id) return dispatchAction(DB, event, { type: 'complete_task', target: { by: 'id', id } })
    return
  }
  if (input.type === 'selection') return answerSelection(DB, event, input.id)

  const action = await parseIntent(AI, AI_MODEL, input.text, event.now)
  if (!action) return '操作を読み取れませんでした。日付やタスク名を添えて、もう一度お試しください。'
  if ('target' in action) {
    if (action.target.by === 'id' && !new RegExp('#' + action.target.id + '(?!\\d)').test(input.text.normalize('NFKC'))) return clarify
    if (action.target.by === 'name' && !input.text.includes(action.target.name)) return clarify
    if (action.target.by === 'recent' && !action.type.includes('reminder') && !/さっき|やっぱり|このタスク|そのタスク|前のタスク|今のタスク/.test(input.text)) return clarify
  }
  return dispatchAction(DB, event, action)
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
