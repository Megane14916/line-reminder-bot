import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery, type PlatformProxy } from 'wrangler'
import migration from '../migrations/0001_init.sql?raw'
import { dispatchAction, type TaskAction } from '../src/tasks/actions'
import { applyEvent, type TaskEvent } from '../src/tasks/repository'

const now = Date.parse('2030-11-14T11:00:00Z')
const event = { groupId: 'group-a', userId: 'user-a', now, eventTime: now }
const checkListFirst = { type: 'text', text: expect.stringMatching(/^まず「一覧を見る」.*有効期限/) }
let platform: PlatformProxy<Env>

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ persist: false, remoteBindings: false, envFiles: [] })
  await platform.env.DB.batch(unstable_splitSqlQuery(migration).map((sql) => platform.env.DB.prepare(sql)))
}, 20_000)

afterAll(async () => await platform?.dispose())

beforeEach(async () => {
  const { DB } = platform.env
  await DB.batch(['tasks', 'interaction_sessions', 'processed_events'].map((table) => DB.prepare(`DELETE FROM ${table}`)))
})

function dispatch(eventId: string, action: TaskAction, context: Partial<TaskEvent> = {}) {
  return dispatchAction(platform.env.DB, { ...event, eventId, ...context }, action)
}

function list(context?: Partial<TaskEvent>) {
  return dispatch('list', { type: 'list' }, context)
}

async function draft(prefix: string, category: 'belonging' | 'deadline' = 'deadline') {
  await dispatch(`${prefix}-start`, { type: 'start_create', category })
  const confirmation = await dispatch(`${prefix}-input`, { type: 'submit_input', text: '11/20 水筒' })
  if (confirmation?.type !== 'confirm_create') throw new Error('Expected a create confirmation')
  return confirmation.token
}

test('confirms once even under redelivery and competing clicks', async () => {
  const token = await draft('a')
  expect(await list()).toMatchObject({ tasks: [] })

  const results = await Promise.all([
    dispatch('confirm', { type: 'confirm', token }),
    dispatch('confirm', { type: 'confirm', token }),
    dispatch('repeated-click', { type: 'confirm', token }),
  ])

  expect(results.filter((result) => result?.type === 'text' && result.text.includes('登録しました'))).toHaveLength(1)
  expect(results).toContainEqual(checkListFirst)
  expect(await dispatch('after-confirm', { type: 'confirm', token })).toMatchObject(checkListFirst)
  expect(await list()).toMatchObject({ tasks: [{ title: '水筒', due_date: '2030-11-20', category: 'deadline' }] })
  expect(await platform.env.DB.prepare('SELECT count(*) FROM processed_events WHERE event_id = ?')
    .bind('confirm').first('count(*)')).toBe(1)
})

test('only the waiting sender and group can submit and confirm', async () => {
  await dispatch('start', { type: 'start_create', category: 'belonging' })
  for (const context of [{ userId: 'other-user' }, { groupId: 'other-group' }]) {
    expect(await dispatch('other', { type: 'submit_input', text: '11/20 水筒' }, context)).toBeUndefined()
  }
  expect(await dispatch('invalid', { type: 'submit_input', text: '11/31 水筒' })).toMatchObject({
    text: expect.stringContaining('確認してください'),
  })
  const result = await dispatch('valid', { type: 'submit_input', text: '11/20 水筒' })
  if (result?.type !== 'confirm_create') throw new Error('Expected a create confirmation')
  expect(result.draft.category).toBe('belonging')
  await dispatch('other-confirm', { type: 'confirm', token: result.token }, { userId: 'other-user' })
  expect(await list()).toMatchObject({ tasks: [] })
  await dispatch('confirm', { type: 'confirm', token: result.token })
  expect(await list()).toMatchObject({ tasks: [{ category: 'belonging' }] })
})

test('expires sessions at ten minutes and invalidates an earlier confirmation on restart', async () => {
  const token = await draft('first')
  const later = now + 10 * 60 * 1000
  expect(await dispatch('expired', { type: 'confirm', token }, { now: later, eventTime: later }))
    .toMatchObject(checkListFirst)
  expect(await list()).toMatchObject({ tasks: [] })
  const newToken = await draft('second')
  expect(await dispatch('old', { type: 'confirm', token })).toMatchObject({ text: expect.stringContaining('有効期限') })
  await dispatch('current', { type: 'confirm', token: newToken })
  await dispatch('out-of-order', { type: 'start_create', category: 'deadline' }, { eventTime: now - 1 })
  expect(await dispatch('after', { type: 'submit_input', text: '11/20 水筒' })).toBeUndefined()
  expect(await list()).toMatchObject({ tasks: [{ title: '水筒' }] })
})

test('scopes complete and delete by group and ID, even for tasks with the same title', async () => {
  for (const prefix of ['first', 'second']) {
    await dispatch(`${prefix}-confirm`, { type: 'confirm', token: await draft(prefix) })
  }
  const result = await list()
  if (result?.type !== 'list') throw new Error('Expected a task list')
  const [first, second] = result.tasks
  expect(first.title).toBe(second.title)
  expect(first.id).not.toBe(second.id)
  const other = { groupId: 'other-group' }
  expect(await list(other)).toMatchObject({ tasks: [] })
  for (const type of ['complete', 'request_delete'] as const) {
    expect(await dispatch(`outside-${type}`, { type, taskId: first.id }, other))
      .toMatchObject({ text: '対象が見つかりません。' })
  }
  await dispatch('complete', { type: 'complete', taskId: first.id })
  const deletion = await dispatch('delete', { type: 'request_delete', taskId: second.id })
  if (deletion?.type !== 'confirm_delete') throw new Error('Expected a delete confirmation')
  expect(await list()).toMatchObject({ tasks: [{ id: second.id }] })
  await dispatch('confirm-delete', { type: 'confirm', token: deletion.token })
  await dispatch('repeat-delete', { type: 'confirm', token: deletion.token })
  expect(await list()).toMatchObject({ tasks: [] })
  const { results } = await platform.env.DB.prepare('SELECT id, status FROM tasks').all()
  expect(results).toEqual([{ id: first.id, status: 'done' }])
})

test('deletes once under competing confirmations and guides a later click to the list', async () => {
  await dispatch('created', { type: 'confirm', token: await draft('delete') })
  const result = await list()
  if (result?.type !== 'list') throw new Error('Expected a task list')
  const deletion = await dispatch('request-delete', { type: 'request_delete', taskId: result.tasks[0].id })
  if (deletion?.type !== 'confirm_delete') throw new Error('Expected a delete confirmation')
  const action = { type: 'confirm', token: deletion.token } as const

  const replies = await Promise.all([dispatch('delete-1', action), dispatch('delete-2', action)])
  expect(replies).toEqual(expect.arrayContaining([
    { type: 'text', text: 'タスクを削除しました。' }, checkListFirst,
  ]))
  expect(await dispatch('delete-3', action)).toMatchObject(checkListFirst)
  expect(await list()).toMatchObject({ tasks: [] })
})

test('lists the first 20 open tasks in due-date order', async () => {
  const { DB } = platform.env
  const insert = DB.prepare(`
    INSERT INTO tasks (group_id, category, title, due_date, status, created_by, created_at)
    VALUES (?, 'deadline', ?, ?, ?, ?, ?)
  `)
  await DB.batch([
    ...Array.from({ length: 21 }, (_, i) =>
      insert.bind(event.groupId, `Task ${i}`, `2030-12-${String(21 - i).padStart(2, '0')}`, 'open', event.userId, now)),
    insert.bind(event.groupId, 'Completed task', '2030-11-30', 'done', event.userId, now),
  ])
  const result = await list()
  if (result?.type !== 'list') throw new Error('Expected a task list')
  expect(result.truncated).toBe(true)
  expect(result.tasks.map((task) => task.due_date))
    .toEqual(Array.from({ length: 20 }, (_, i) => `2030-12-${String(i + 1).padStart(2, '0')}`))
})

test('rolls back the processed event record when a mutation fails', async () => {
  const { DB } = platform.env
  const insert = DB.prepare(`
    INSERT INTO tasks (group_id, category, title, due_date, created_by, created_at)
    VALUES (?, ?, '水筒', '2030-11-20', ?, ?)
  `)
  const retryable = { ...event, eventId: 'retryable' }
  await expect(applyEvent(DB, retryable, insert.bind(event.groupId, 'invalid', event.userId, now))).rejects.toThrow()
  await expect(applyEvent(DB, retryable, insert.bind(event.groupId, 'belonging', event.userId, now)))
    .resolves.toHaveLength(1)
  expect(await list()).toMatchObject({ tasks: [{ category: 'belonging' }] })
})
