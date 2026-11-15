import { Hono } from 'hono'
import { lineWebhook } from './line/webhook'
import { drainInbox } from './line/inbox'
import { drainResults } from './line/outbox'
import { reminderCron, runReminders } from './reminders'
import { runtimeBudget, withinBudget } from './runtime-budget'
import { expireConversation } from './tasks/conversation'

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.route('/webhook/line', lineWebhook)

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    if (controller.cron !== reminderCron) return
    const budget = runtimeBudget()
    await withinBudget(budget, async () => {
      const jobs = ['inbox', 'outbox', 'reminders', 'conversation']
      const results = await Promise.allSettled([drainInbox(env, budget), drainResults(env, budget), runReminders(env, budget.clock, budget),
        expireConversation(env.DB, budget.clock())])
      results.forEach((result, index) => {
        if (result.status === 'rejected') console.error('Scheduled processing failed', { job: jobs[index] })
      })
      if (results.some((result) => result.status === 'rejected')) throw new Error('Scheduled processing failed')
    })
  },
} satisfies ExportedHandler<Env>
