import {
  applyEvent, completeTask, confirmDraft, consumeSession, deleteTask, findOpenTask,
  getSession, insertTask, listTasks, startSession, wasProcessed,
  type Task, type TaskCategory, type TaskDraft, type TaskEvent,
} from './repository'
import { looksLikeTaskInput, parseTaskInput, todayInJapan } from './validation'

export type TaskAction =
  | { type: 'start_create'; category: TaskCategory }
  | { type: 'submit_input'; text: string }
  | { type: 'list' }
  | { type: 'complete'; taskId: number }
  | { type: 'request_delete'; taskId: number }
  | { type: 'confirm'; token: string }

export type ActionResult =
  | { type: 'text'; text: string }
  | { type: 'confirm_create'; draft: TaskDraft; token: string }
  | { type: 'confirm_delete'; task: Task; token: string }
  | { type: 'list'; tasks: Task[]; truncated: boolean }

const inputExample = '日付とタイトルを送ってください。例 11/20 遠足の同意書（10分以内）'
const expired = '操作の有効期限が切れたか、すでに処理済みです。メニューからやり直してください。'
const inactiveConfirmation = 'まず「一覧を見る」で操作結果を確認してください。この確認ボタンは有効期限切れか、すでに使われた可能性があります。必要ならメニューから操作し直してください。'
const missing = '対象が見つかりません。'

function textResult(text: string): ActionResult {
  return { type: 'text', text }
}

export async function dispatchAction(db: D1Database, event: TaskEvent, action: TaskAction): Promise<ActionResult | undefined> {
  switch (action.type) {
    case 'list':
      return { type: 'list', ...await listTasks(db, event.groupId) }
    case 'start_create': {
      const statement = startSession(db, event, {
        state: 'awaiting_input', token: crypto.randomUUID(), payload: { category: action.category },
      })
      const results = await applyEvent(db, event, statement)
      if (results) return textResult(results[0].meta.changes ? inputExample : expired)
      return
    }
    case 'submit_input': {
      if (!looksLikeTaskInput(action.text)) return

      const session = await getSession(db, event)
      if (session?.state !== 'awaiting_input') return

      const input = parseTaskInput(action.text, event.now)
      if (!input) return textResult(`日付またはタイトルを確認してください。${inputExample}`)

      const draft = { ...input, category: session.payload.category }
      const token = crypto.randomUUID()
      const results = await applyEvent(db, event, confirmDraft(db, event, session.token, token, draft))
      if (results?.[0].meta.changes) return { type: 'confirm_create', draft, token }
      return
    }
    case 'complete': {
      const results = await applyEvent(db, event, completeTask(db, event, action.taskId))
      if (results) return textResult(results[0].meta.changes ? 'タスクを完了しました。' : missing)
      return
    }
    case 'request_delete': {
      const task = await findOpenTask(db, event.groupId, action.taskId)
      if (!task) return textResult(missing)

      const token = crypto.randomUUID()
      const statement = startSession(db, event, { state: 'confirm_delete', token, payload: { taskId: task.id } })
      const results = await applyEvent(db, event, statement)
      if (results) return results[0].meta.changes ? { type: 'confirm_delete', task, token } : textResult(expired)
      return
    }
    case 'confirm':
      return confirmAction(db, event, action.token)
  }
}

async function confirmAction(db: D1Database, event: TaskEvent, token: string) {
  const session = await getSession(db, event)
  if (!session || session.token !== token || session.state === 'awaiting_input') {
    if (!await wasProcessed(db, event.eventId)) return textResult(inactiveConfirmation)
    return
  }

  const consume = consumeSession(db, event, token)
  if (session.state === 'confirm_create' && session.payload.dueDate < todayInJapan(event.now)) {
    const results = await applyEvent(db, event, consume)
    if (results) return textResult('期限が過ぎました。メニューから登録し直してください。')
    return
  }

  const change = session.state === 'confirm_create'
    ? insertTask(db, event, token, session.payload)
    : deleteTask(db, event, token, session.payload.taskId)
  const results = await applyEvent(db, event, change, consume)
  if (!results) return
  const [task, currentSession] = results
  if (!currentSession.meta.changes) return textResult(inactiveConfirmation)
  if (!task.meta.changes) return textResult(missing)
  return textResult(session.state === 'confirm_create' ? 'タスクを登録しました。' : 'タスクを削除しました。')
}
