import { formatIntentError } from '../line/messages'
import type { Clarification } from './intent'
import { applyEvent, getContext, saveContext, type TaskEvent } from './repository'
import type { PendingDialogue } from './dialogue'
import { dateTimeEvidence } from './draft'
import { explicitNotificationDates, relativeDays } from './notification-dates'

export async function askClarification(db: D1Database, event: TaskEvent, question: Clarification, taskId?: number, prompt?: string) {
  const reply = prompt ?? formatIntentError(question)
  if (!event.text) return reply
  const previous = event.pendingPlan ?? event.thread?.pending
  const pending: PendingDialogue = { ...previous, question, prompt: reply, originalAt: previous?.originalAt ?? event.eventTime,
    quotedAt: event.quotedAt, action: event.interpretedAction }
  return holdDialogue(db, event, pending, taskId)
}

export async function holdDialogue(db: D1Database, event: TaskEvent, pending: PendingDialogue, taskId?: number) {
  const context = await getContext(db, event)
  const thread = { ...(event.thread ?? { id: event.eventId, original: event.text ?? '', taskId: null }), pending }
  thread.taskId = taskId ?? thread.taskId
  if (await applyEvent(db, { ...event, thread, linkTask: thread.taskId !== null, turn: { operation: 'clarify', question: pending.prompt } },
    pending.prompt, saveContext(db, event, 'clarification', thread.taskId ?? context?.task_id ?? null))) return pending.prompt
}

// An unaddressed group message needs a bounded, pending-question-shaped signal before intake.
// The model decides what the admitted message means using the whole draft.
export function followupQuestions(text: string, now: number): PendingDialogue['question'][] {
  const answer = text.normalize('NFKC').trim().replace(/[。！!]+$/u, '')
  if (/^(?:やっぱり?\s*)?(?:(?:今の)?(?:なし|取り消して)|キャンセル)(?:で|でお願い)?$/.test(answer)) return ['time', 'day', 'mode', 'task', 'title']
  if (delegatesClock(answer)) return ['time']
  const { dates, times, invalidDay, invalidTime } = dateTimeEvidence(answer, now)
  const questions: PendingDialogue['question'][] = []
  if (!/[?？]$/.test(answer)) {
    const phrase = (answer.split(/[、,。]|だから|なので/).at(-1) ?? answer).trim().replace(/^(?:やっぱり?|できれば)\s*/, '')
    const startsWithClock = /^(?:(?:朝|夜|午前|午後)\s*)?\d{1,2}(?:時|:\d{2})/.test(phrase)
    const datedClock = explicitNotificationDates(phrase, now).some(({ time, index }) => time && index === 0)
    const relativeClock = relativeDays(phrase).length > 0 &&
      /^(?:\d+(?:日|週間)前|前日|当日)(?:の|は)?(?:朝|夜|午前|午後)?\d{1,2}(?:時|:\d{2})/.test(phrase)
    if ((startsWithClock || datedClock || relativeClock) && (times.length || invalidTime) &&
      /(?:時(?:\d+分|半)?|:\d{2})(?:\s*(?:に|で)(?:して|いい|お願い(?:します)?|通知して)?|\s*通知して)?$/.test(phrase)
      || /^(?:今日|明日|明後日)の(?:朝|昼|夜)(?:に(?:して|通知して)|で)?$/.test(phrase)) questions.push('time')
    if (dates.length || invalidDay || /(?:日前|週間前|前日|当日)(?:で|に|の通知)?$/.test(answer)) {
      if (questions.includes('time') || /(?:日|曜|明日|明後日|\d\/\d{1,2}|\d日前|前日|当日)(?:で|に|の通知)?$/.test(answer)) questions.push('day')
    }
    if (/^(?:(?:今の通知に)?追加|置き換え|入れ替え)(?:で|して|でお願い(?:します)?)?$/.test(answer)) questions.push('mode')
  }
  return questions
}

export function delegatesClock(text: string) {
  return /^(?:(?:いつもと同じ|いつもの(?:時間|やつ)|(?:他|ほか)の通知と(?:同じ|合わせて))(?:で|でいい(?:よ|です)?|にして)?|任せる|お任せ(?:で|します)?|適当でいい(?:よ|です)?|(?:朝|夕方|夜)でいい(?:よ|です)?)[。！!]*$/.test(text.trim())
}
