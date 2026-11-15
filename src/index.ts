import { Hono } from 'hono'
import { lineWebhook } from './line/webhook'
import { drainInbox } from './line/inbox'
import { reminderCron, runReminders } from './reminders'

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.route('/webhook/line', lineWebhook)

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    if (controller.cron !== reminderCron) return
    const [inbox, reminders] = await Promise.allSettled([drainInbox(env), runReminders(env)])
    if (inbox.status === 'rejected') console.error('LINE inbox cron failed')
    if (reminders.status === 'rejected') console.error('Deadline reminder cron failed')
    if (inbox.status === 'rejected' || reminders.status === 'rejected') throw new Error('Scheduled processing failed')
  },
} satisfies ExportedHandler<Env>
