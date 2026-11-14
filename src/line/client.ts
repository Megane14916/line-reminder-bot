import type { ReplyMessage } from './messages'

type ReplyResult =
  | { ok: true }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network' }

export async function sendReply(accessToken: string, replyToken: string, messages: ReplyMessage[]): Promise<ReplyResult> {
  const body = JSON.stringify({ replyToken, messages })
  let response: Response
  try {
    response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    })
  } catch {
    return { ok: false, kind: 'network' }
  }
  return response.ok ? { ok: true } : { ok: false, kind: 'http', status: response.status }
}
