import type { ActionResult, TaskAction } from '../tasks/actions'
import type { Task, TaskCategory } from '../tasks/repository'

const menuItems = [
  { data: 'add_deadline', label: '期限を追加', action: { type: 'start_create', category: 'deadline' } },
  { data: 'add_belonging', label: '持ち物を追加', action: { type: 'start_create', category: 'belonging' } },
  { data: 'list_tasks', label: '一覧を見る', action: { type: 'list' } },
  { data: 'help', label: '使い方', action: { type: 'help' } },
] satisfies { data: string; label: string; action: TaskAction | { type: 'help' } }[]

export const helpMessage = textMessage('Bot にメンションして操作メニューを開きます。追加を選んだら「11/20 水筒」のように日付とタイトルを送り、確認ボタンを押してください。完了と削除は一覧から操作できます。')

export function parsePostback(data: unknown): TaskAction | { type: 'help' } | undefined {
  if (typeof data !== 'string') return
  const item = menuItems.find((item) => item.data === data)
  if (item) return item.action

  const task = /^(complete|delete):([1-9][0-9]*)$/.exec(data)
  if (task) {
    const taskId = Number(task[2])
    if (Number.isSafeInteger(taskId)) return { type: task[1] === 'complete' ? 'complete' : 'request_delete', taskId }
  }

  const confirmation = /^confirm:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(data)
  if (confirmation) return { type: 'confirm', token: confirmation[1] }
}

export function createMenuMessage() {
  return flexMessage('家族Botの操作メニュー', bubble(menuItems.map(({ data, label }) => button(label, data))))
}

export function createActionMessages(result: ActionResult): ReplyMessage[] {
  switch (result.type) {
    case 'text':
      return [textMessage(result.text)]
    case 'confirm_create': {
      const { draft, token } = result
      return [flexMessage('登録の確認', bubble([
        flexText(`${categoryLabel(draft.category)} ${draft.dueDate}\n${draft.title}`),
        button('登録する', `confirm:${token}`),
      ]))]
    }
    case 'confirm_delete':
      return [flexMessage('削除の確認', bubble([
        flexText(`${taskLabel(result.task)}\nこのタスクを削除しますか？`),
        button('削除する', `confirm:${result.token}`),
      ]))]
    case 'list': {
      if (!result.tasks.length) return [textMessage('未完了のタスクはありません。')]
      const messages: ReplyMessage[] = []
      if (result.truncated) messages.push(textMessage('未完了のタスクのうち、期限が近い順に最初の20件を表示します。'))
      // LINE accepts at most 12 bubbles per carousel.
      for (let start = 0; start < result.tasks.length; start += 12) {
        const contents = result.tasks.slice(start, start + 12).map((task) => bubble([
          flexText(taskLabel(task)), button('完了', `complete:${task.id}`), button('削除', `delete:${task.id}`),
        ]))
        messages.push(flexMessage('未完了のタスク', { type: 'carousel', contents }))
      }
      return messages
    }
  }
}

function categoryLabel(category: TaskCategory) {
  return category === 'deadline' ? '期限' : '持ち物'
}

function taskLabel(task: Task) {
  return `${categoryLabel(task.category)} ${task.due_date}\n${task.title}\n#${task.id}`
}

function textMessage(text: string) {
  return { type: 'text' as const, text }
}

function flexText(text: string) {
  return { ...textMessage(text), wrap: true }
}

function button(label: string, data: string) {
  return { type: 'button' as const, action: { type: 'postback' as const, label, data } }
}

function bubble(contents: (ReturnType<typeof flexText> | ReturnType<typeof button>)[]) {
  return { type: 'bubble' as const, body: { type: 'box' as const, layout: 'vertical' as const, spacing: 'sm', contents } }
}

function flexMessage(altText: string, contents: ReturnType<typeof bubble> | { type: 'carousel'; contents: ReturnType<typeof bubble>[] }) {
  return { type: 'flex' as const, altText, contents }
}

export type ReplyMessage = ReturnType<typeof textMessage> | ReturnType<typeof flexMessage>
