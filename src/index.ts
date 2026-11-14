import { Hono } from 'hono'
import { lineWebhook } from './line/webhook'
import { deadlineCron, retryCron, retryDeadlineReminders, sendDeadlineReminders } from './reminders'

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.route('/webhook/line', lineWebhook)

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    try {
      if (controller.cron === deadlineCron) await sendDeadlineReminders(env, controller.scheduledTime)
      if (controller.cron === retryCron) await retryDeadlineReminders(env)
    } catch {
      console.error('Deadline reminder cron failed', { cron: controller.cron, stage: 'load', kind: 'configuration_or_d1' })
      throw new Error('Could not start deadline reminder processing')
    }
  },
} satisfies ExportedHandler<Env>
