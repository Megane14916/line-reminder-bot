import { Hono } from 'hono'
import { lineWebhook } from './line/webhook'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.route('/webhook/line', lineWebhook)

export default app
