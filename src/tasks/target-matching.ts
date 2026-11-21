export function taskKey(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/申し込[みむ]|申込み/g, '申込')
    .replace(/[\s\p{P}の]/gu, '')
}

export function namesTarget(text: string, name: string) {
  const normalized = text.normalize('NFKC')
  if (normalized.includes(name.normalize('NFKC'))) return true
  const key = taskKey(name)
  return key.length >= 2 && taskKey(text).includes(key)
}

export function cleanTargetReference(name: string) {
  return name.replace(/(?:のやつ|のこと|の件)(?:って)?$/u, '').trim() || name
}
