import { formatIntentError } from '../line/messages'
import type { Clarification } from './intent'
import { applyEvent, getContext, saveContext, type PendingClarification, type TaskEvent } from './repository'

export async function askClarification(db: D1Database, event: TaskEvent, question: Clarification, taskId?: number, prompt?: string) {
  const reply = prompt ?? formatIntentError(question)
  if (!event.text) return reply
  const context = await getContext(db, event)
  const pending: PendingClarification = { kind: 'clarification', question, text: event.text, quoteTaskId: event.quoteTaskId }
  if (await applyEvent(db, { ...event, linkTask: taskId !== undefined, turn: { operation: 'clarify', question: reply } }, reply,
    saveContext(db, event, 'clarification', taskId ?? context?.task_id ?? null, JSON.stringify(pending)))) return reply
}

export function isClarificationAnswer(question: Clarification, text: string) {
  const answer = text.normalize('NFKC').replace(/[\s。！!]+$/gu, '')
  switch (question) {
    case 'time': return /^(?:朝|夜|午前|午後)?\d{1,2}(?::\d{2}|時(?:\d{1,2}分|半)?)(?:で|に|でお願い(?:します)?|にして)?$/.test(answer)
    case 'day': return /^(?:(?:\d{1,3}|[一二三四五六七八九十]+)(?:日|週間)前|前日|当日|明日|(?:\d{4}[-/年])?\d{1,2}[-/月]\d{1,2}日?)(?:で|に|の通知|を消して)?$/.test(answer)
    case 'mode': return /^(?:(?:今の通知に)?追加|置き換え|入れ替え)(?:で|して|でお願い(?:します)?)?$/.test(answer)
    case 'task': return answer.length > 0 && answer.length <= 100
  }
}
