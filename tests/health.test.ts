import { expect, test } from 'vitest'
import app from '../src/index'

test('GET /health returns the Worker status', async () => {
  const response = await app.request('/health')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
})
