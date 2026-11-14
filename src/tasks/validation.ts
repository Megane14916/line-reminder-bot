const jstDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function todayInJapan(now: number) {
  return jstDate.format(now)
}

export function daysUntil(dueDate: string, now: number) {
  return (Date.parse(dueDate) - Date.parse(todayInJapan(now))) / 86_400_000
}
