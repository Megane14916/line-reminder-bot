import { Hono } from 'hono'
import { lineWebhook } from './line/webhook'
import { sendDeadlineReminders } from './reminders'

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.route('/webhook/line', lineWebhook)

export default {
  fetch: app.fetch,
  scheduled(controller, env) {
    return sendDeadlineReminders(env, controller.scheduledTime)
  },
} satisfies ExportedHandler<Env>
