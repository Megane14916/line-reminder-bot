import { expect, test } from 'vitest'
import { runtimeBudget, withinBudget } from '../src/runtime-budget'

test('ends the wait on a stalled request and closes the budget to its late continuation', async () => {
  const budget = runtimeBudget(() => 0, 10)
  const database = Promise.withResolvers<void>()
  let afterDatabase: number | undefined
  await withinBudget(budget, async () => {
    await database.promise
    afterDatabase = budget.remaining()
  })
  expect(budget.remaining()).toBe(0)
  database.resolve()
  await database.promise
  expect(afterDatabase).toBe(0)
})
