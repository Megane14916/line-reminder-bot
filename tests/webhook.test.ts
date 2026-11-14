import { expect, test } from 'vitest'
import app from '../src/index'

// LINE's published signature verification example.
const bindings = { LINE_CHANNEL_SECRET: '8c570fa6dd201bb328f1c1eac23a96d8' }
const exampleBody = '{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}'
const exampleSignature = 'GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs='

function post(body: string, signature?: string) {
  return app.request('/webhook/line', {
    method: 'POST',
    headers: signature ? { 'x-line-signature': signature } : {},
    body,
  }, bindings)
}

test('accepts a signed empty webhook', async () => {
  const response = await post(exampleBody, exampleSignature)

  expect(response.status).toBe(200)
})

test.each([
  ['a missing signature', exampleBody, undefined],
  ['malformed base64', exampleBody, 'invalid!'],
  ['a tampered body', `${exampleBody}\n`, exampleSignature],
  ['unsigned malformed JSON', '{', exampleSignature],
])('returns 401 for %s', async (_description, body, signature) => {
  const response = await post(body, signature)

  expect(response.status).toBe(401)
})
