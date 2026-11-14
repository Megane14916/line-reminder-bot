import type { ReplyMessage } from './messages'

export async function sendReply(accessToken: string, replyToken: string, messages: ReplyMessage[]) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ replyToken, messages }),
    })

    if (!response.ok) console.error('LINE Reply API returned HTTP', response.status)
  } catch {
    console.error('LINE Reply API request failed')
  }
}
