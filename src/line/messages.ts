const menuItems = [
  { data: 'add_deadline', label: '期限を追加', reply: '期限の追加を選びました。登録機能は準備中です。' },
  { data: 'add_belonging', label: '持ち物を追加', reply: '持ち物の追加を選びました。登録機能は準備中です。' },
  { data: 'list_tasks', label: '一覧を見る', reply: '一覧を選びました。一覧表示は準備中です。' },
  { data: 'help', label: '使い方', reply: 'このグループで Bot にメンションを送ると操作メニューが開きます。' },
]

export function createMenuMessage() {
  return {
    type: 'flex' as const,
    altText: '家族Botの操作メニュー',
    contents: {
      type: 'bubble' as const,
      body: {
        type: 'box' as const,
        layout: 'vertical' as const,
        spacing: 'sm',
        contents: menuItems.map(({ data, label }) => ({
          type: 'button' as const,
          action: { type: 'postback' as const, label, data },
        })),
      },
    },
  }
}

export function createPostbackMessage(data: unknown) {
  const item = menuItems.find((item) => item.data === data)
  if (item) return { type: 'text' as const, text: item.reply }
}

export type ReplyMessage = ReturnType<typeof createMenuMessage> | NonNullable<ReturnType<typeof createPostbackMessage>>
