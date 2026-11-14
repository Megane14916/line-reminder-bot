const jstDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function todayInJapan(now: number) {
  return jstDate.format(now)
}

export function parseTaskInput(text: string, now: number) {
  const input = /^(\S+)\s+([\s\S]+)$/.exec(text.trim())
  if (!input) return

  const title = input[2].trim()
  if (!title || [...title].length > 100 || title.includes('\0')) return

  const dueDate = parseDueDate(input[1], todayInJapan(now))
  if (dueDate) return { title, dueDate }
}

function parseDueDate(input: string, today: string) {
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (full) {
    if (input >= today && isCalendarDate(Number(full[1]), Number(full[2]), Number(full[3]))) return input
    return
  }

  const short = /^(\d{1,2})\/(\d{1,2})$/.exec(input)
  if (!short) return
  const month = Number(short[1])
  const day = Number(short[2])
  // A leap year covers every valid month/day combination.
  if (!isCalendarDate(2000, month, day)) return

  for (let year = Number(today.slice(0, 4)); year <= 9999; year++) {
    const date = `${year}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`
    if (date >= today && isCalendarDate(year, month, day)) return date
  }
}

function isCalendarDate(year: number, month: number, day: number) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
}
