import type { DraftEdit, DraftEditPatch, TaskDraft } from './intent'
import { explicitNotificationDates, explicitNotificationTimes, relativeDays } from './notification-dates'

type Destination = NonNullable<Extract<DraftEdit, { op: 'add' }>['when']> |
  NonNullable<Extract<DraftEdit, { op: 'move' }>['to']>
type Fields = TaskDraft['fields']

export function draftEdits(fields: Fields): DraftEdit[] {
  return fields.edits ?? (fields.notice ? [{ op: 'add', when: fields.notice }] : [])
}

export function nextEditQuestion(edits: DraftEdit[]) {
  for (const [index, edit] of edits.entries()) {
    const value = edit.op === 'add' ? edit.when : edit.op === 'move' ? edit.to : undefined
    if ((edit.op === 'add' || edit.op === 'move') && (!value ||
      value.kind === 'absolute' && !value.date || value.kind === 'relative' && value.daysBefore === undefined)) {
      return { index, question: 'day' as const }
    }
    if (value && !value.time || (edit.op === 'add_clock' || edit.op === 'set_clock') && !edit.time) {
      return { index, question: 'time' as const }
    }
  }
}

function hasDay(value: Destination, text: string, now: number) {
  return value.kind === 'absolute' ? explicitNotificationDates(text, now).some(({ date }) => date === value.date)
    : value.kind === 'relative' && relativeDays(text.normalize('NFKC')).includes(value.daysBefore ?? -1)
}

const originalRemoval = /(?:消して|削除(?:して|したい)|いらな|なくして|取り除いて)/
const keep = /(?:消さない|消すの(?:は|を)やめ|削除しない|削除(?:は|を)(?:取り消|やめ)|残して|そのまま)/
const correction = /(?:やっぱ|変更|変えて|じゃなく|ではなく|代わり|にして)/
const clauses = (text: string) => text.split(/[、,。\n]/).map((clause) => clause.trim()).filter(Boolean)

function removalMentioned(edit: Extract<DraftEdit, { op: 'remove' }>, text: string, now: number) {
  const sel = edit.selector
  return sel.kind === 'recent' ? /この通知|その通知|さっきの/.test(text)
    : sel.kind === 'time' ? explicitNotificationTimes(text).includes(sel.time)
      : hasDay(sel, text, now)
}

export function justifiedRemovals(edits: DraftEdit[], original: string, now: number) {
  return edits.every((edit) => edit.op !== 'remove' || clauses(original).some((clause) =>
    originalRemoval.test(clause) && !keep.test(clause) && removalMentioned(edit, clause, now)))
}

function sameDay(a: Destination, b: Destination) {
  return a.kind === 'absolute' ? b.kind === 'absolute' && a.date === b.date
    : a.kind === 'relative' ? b.kind === 'relative' && a.daysBefore === b.daysBefore : b.kind === 'time'
}

function preservesSelector(old: Extract<DraftEdit, { op: 'remove' }>['selector'],
  proposed: Extract<DraftEdit, { op: 'remove' }>['selector']) {
  if (old.kind !== proposed.kind || old.time !== undefined && old.time !== proposed.time) return false
  if (old.kind === 'absolute') return proposed.kind === 'absolute' && old.date === proposed.date
  if (old.kind === 'relative') return proposed.kind === 'relative' && old.daysBefore === proposed.daysBefore
  return true
}

function withDestination(old: Destination | undefined, proposed: Destination | undefined, text: string, now: number) {
  if (!proposed) return old
  const clock = proposed.time
  if (clock && clock !== old?.time && !explicitNotificationTimes(text).includes(clock)) return
  if (!old) return hasDay(proposed, text, now) || proposed.kind === 'time' ? proposed : undefined
  if (old.kind === 'absolute' && proposed.kind === 'absolute' && !proposed.date) return { ...old, time: clock ?? old.time }
  if (old.kind === 'relative' && proposed.kind === 'relative' && proposed.daysBefore === undefined) return { ...old, time: clock ?? old.time }
  if (sameDay(old, proposed)) return { ...old, time: clock ?? old.time }
  const dayUnspecified = old.kind === 'absolute' ? !old.date : old.kind === 'relative' && old.daysBefore === undefined
  if ((!dayUnspecified && !correction.test(text)) || !hasDay(proposed, text, now)) return
  return { ...proposed, time: clock ?? old.time }
}

type Update = { type?: 'continue' | 'draft'; fields: Fields; patches?: DraftEditPatch[] }

// The prior array determines scope and order. A model snapshot can only fill it in, or
// reflect changes corroborated by the current user's answer.
export function reconcileEditedDraft(fields: Fields, update: Update, text: string, now: number, editText: string, originalAt: number,
  requireCancellation = false) {
  const base = draftEdits(fields)
  const asked = nextEditQuestion(base)
  const provided = update.fields.edits
  const snapshot = update.type === 'continue' && provided?.length === 1 && base.length > 1 && asked &&
    base[asked.index].op === provided[0].op ? base.map((edit, index) => index === asked.index ? provided[0] : edit) : provided
  const patches = update.patches ?? []
  if (snapshot && patches.length || new Set(patches.map(({ index }) => index)).size !== patches.length ||
    patches.some(({ index }) => index >= base.length)) return
  const removed = new Set<number>()
  const evidence = clauses(text)
  const original = clauses(editText)
  let grounding = original
  for (const [index, edit] of base.entries()) {
    if (edit.op !== 'remove') continue
    const cancelled = evidence.some((clause) => keep.test(clause) && removalMentioned(edit, clause, now))
    if (!cancelled) continue
    removed.add(index)
    grounding = grounding.filter((clause) => !(originalRemoval.test(clause) && removalMentioned(edit, clause, originalAt)))
  }
  if (requireCancellation && removed.size === 0) return
  if (patches.some(({ index, drop }) => drop && !removed.has(index))) return
  const full = snapshot?.length === base.length
  if (snapshot && !full && snapshot.length !== base.length - removed.size) return
  const next: DraftEdit[] = []
  let current = 0
  const times = explicitNotificationTimes(text)
  const plainClock = times.length === 1 && !relativeDays(text.normalize('NFKC')).length && !explicitNotificationDates(text, now).length
  for (const [index, edit] of base.entries()) {
    const patch = patches.find((part) => part.index === index)
    const suggested = snapshot?.[full ? index : current]
    if (removed.has(index)) {
      if (full && JSON.stringify(suggested) !== JSON.stringify(edit)) return
      continue
    }
    current++
    if (suggested && suggested.op !== edit.op) return
    let change: DraftEdit = edit
    if (edit.op === 'add' || edit.op === 'move') {
      const from = edit.op === 'add' ? edit.when : edit.to
      const notice = update.fields.notice
      const legacy = asked?.index === index && notice && from && plainClock && notice.time === times[0]
        ? { ...from, time: notice.time } : notice
      let submitted = edit.op === 'add'
        ? patch?.when ?? (suggested?.op === 'add' ? suggested.when : undefined) ?? (asked?.index === index ? legacy : undefined)
        : patch?.to ?? (suggested?.op === 'move' ? suggested.to : undefined)
      if (patch && (edit.op === 'add' ? patch.to : patch.when)) return
      if (patch?.time) {
        const destination = submitted ?? from
        if (!destination || submitted?.time && submitted.time !== patch.time) return
        submitted = { ...destination, time: patch.time }
      }
      if (edit.op === 'move' && suggested?.op === 'move' && !preservesSelector(edit.selector, suggested.selector)) return
      let destination = withDestination(from, submitted, text, now)
      if (submitted && !destination) return
      if (asked && asked.index !== index && destination?.time !== from?.time &&
        (!destination || !hasDay(destination, text, now))) return
      if (destination && !destination.time && asked?.index === index && asked.question === 'time' && times.length === 1 && times[0]) {
        destination = { ...destination, time: times[0] }
      }
      if (from && destination && !sameDay(from, destination)) {
        // Drop only the superseded addition. If a clause also expressed another saved edit,
        // leave it for final validation to request a clearer correction.
        grounding = grounding.filter((clause) => !hasDay(from, clause, originalAt) || originalRemoval.test(clause) ||
          base.some((other) => other !== edit && other.op === 'add' && other.when && hasDay(other.when, clause, originalAt)))
      }
      if (from?.time && destination?.time && from.time !== destination.time) {
        const currentTime = from.time
        grounding = grounding.filter((clause) => !hasDay(from, clause, originalAt) || !explicitNotificationTimes(clause).includes(currentTime))
      }
      if (edit.op === 'add' && destination?.kind === 'time') return
      change = edit.op === 'add' ? { op: 'add', when: destination as typeof edit.when } : { ...edit, to: destination }
    } else if (edit.op === 'set_clock' || edit.op === 'add_clock') {
      if (patch?.when || patch?.to) return
      if (edit.op === 'set_clock' && suggested?.op === 'set_clock' && suggested.except &&
        JSON.stringify(suggested.except) !== JSON.stringify(edit.except)) return
      const proposed = patch?.time ?? (suggested?.op === edit.op ? suggested.time : undefined)
      if (proposed && edit.time !== proposed && (!times.includes(proposed) ||
        asked && asked.index !== index && !/全部|すべて|全て|一律/.test(text))) return
      const time = proposed ?? edit.time ?? (asked?.index === index && times.length === 1 ? times[0] : undefined)
      change = { ...edit, time }
    } else if (patch || suggested && !(edit.op === 'remove' && suggested.op === 'remove'
      ? preservesSelector(edit.selector, suggested.selector) : JSON.stringify(suggested) === JSON.stringify(edit))) return
    next.push(change)
  }
  if (!next.length) return
  // Keep the user evidence used for final validation, without asking the model to reconstruct it.
  const answer = evidence.filter((clause) => !keep.test(clause))
  return { edits: next, editText: [...new Set([...grounding, ...answer])].join('。') }
}

export function withoutVagueClock(text: string) {
  return text.replace(/(?:の)?(?:朝|夜|夕方)(?=(?:にも|に通知|の通知))/g, '')
}
