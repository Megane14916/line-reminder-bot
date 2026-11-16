type Case = {
  name: string
  turns: string[]
  date?: string
  category?: 'belonging' | 'deadline'
  notice?: string
  question?: boolean
  quoted?: boolean
  done?: boolean
  scoped?: boolean
}

export const deviceCases: Case[] = [
  { name: '教科書の日付', turns: ['教科書 11/20'], date: '2026-11-20', category: 'belonging' },
  { name: '体操服の年越し', turns: ['体操服 1/2'], date: '2027-01-02', category: 'belonging' },
  { name: '英検の短文', turns: ['英検申し込み 11/17'], date: '2026-11-17', category: 'deadline' },
  { name: '日付が文の途中', turns: ['教科書 明日 持ってく'], date: '2026-11-17', category: 'belonging' },
  { name: '持参する体操服', turns: ['体操服を持っていく 1/2'], date: '2027-01-02', category: 'belonging' },
  { name: '履歴書の短文', turns: ['履歴書書く 12/5'], date: '2026-12-05', category: 'deadline' },
  { name: '口語の持参', turns: ['明日教科書持ってく'], date: '2026-11-17', category: 'belonging' },
  { name: '金曜まで', turns: ['体操服、金曜まで'], date: '2026-11-20', category: 'belonging' },
  { name: '忘れそう', turns: ['明日の物理の教科書忘れそう'], date: '2026-11-17', category: 'belonging' },
  { name: '来週の金曜', turns: ['来週の金曜日に図工の材料を持っていく'], date: '2026-11-27', category: 'belonging' },
  { name: '期限まで', turns: ['12/5までに履歴書を書かなくちゃ'], date: '2026-12-05', category: 'deadline' },
  { name: '未使用の語順', turns: ['予備のコンパス、11/20に持ってく'], date: '2026-11-20', category: 'belonging' },
  { name: '全角日付', turns: ['遠足の申込書 １２／５'], date: '2026-12-05', category: 'deadline' },
  { name: '年月日の指定', turns: ['2027年1月2日、上履き持参'], date: '2027-01-02', category: 'belonging' },
  { name: 'タスクに通知を付ける', turns: ['明日物理の教科書を持っていく。今日の21時に通知して'],
    date: '2026-11-17', category: 'belonging', notice: '2026-11-16T21:00:00+09:00' },
  { name: '翌日早朝の通知', turns: ['11/20に履歴書を提出。11/17の午前0時35分にも通知して'],
    date: '2026-11-20', category: 'deadline', notice: '2026-11-17T00:35:00+09:00' },
  { name: '半の時刻', turns: ['明後日までに願書を書く。今日の夜9時半に通知して'],
    date: '2026-11-18', category: 'deadline', notice: '2026-11-16T21:30:00+09:00' },
  { name: '明後日に修正', turns: ['教科書 11/20', 'さっきのやつ、明後日に変更'],
    date: '2026-11-18', category: 'belonging' },
  { name: 'あれが完了', turns: ['履歴書書く 12/5', 'あれもう終わった'], date: '2026-12-05', category: 'deadline', done: true },
  { name: '引用で変更', turns: ['教科書 11/20', 'これは明後日に変更して'], date: '2026-11-18', category: 'belonging', quoted: true },
  { name: '明確な雑談', turns: ['今日の晩ご飯何にしようか？'] },
  { name: '仮定の依頼', turns: ['もし履歴書を書くなら12/5が締切って仮定で話そう'] },
  ...['21時', '21時で', '夜9時', '21:00', '今日の21時にして', '11/16の21時に通知して', 'やっぱり21時でいい',
    '明日持っていくものだから今日の21時'].map((answer, index) => ({
    name: '時刻の回答 ' + answer, turns: ['明日物理の教科書を持っていくから、今日の夜通知して', answer],
    date: '2026-11-17', category: 'belonging' as const, notice: '2026-11-16T21:00:00+09:00',
    question: true, quoted: index === 1 || index === 5,
  })),
  { name: '追加してから時刻を訂正', turns: ['明日教科書持ってく', '今日の夜にも通知して', '21時', 'やっぱ20時'],
    date: '2026-11-17', category: 'belonging', notice: '2026-11-16T20:00:00+09:00', question: true },
  { name: '元の予定を中止', turns: ['明日物理の教科書を持っていくから、今日の夜通知して', 'やっぱなし', '21時'], question: true },
  { name: '別のタイトルで新規登録', turns: ['明日物理の教科書を持っていくから、今日の夜通知して', '体操服 1/2', '21時'],
    date: '2027-01-02', category: 'belonging', question: true },
  { name: '別の人の時刻は無視', turns: ['明日物理の教科書を持っていくから、今日の夜通知して', '20時', '21時'],
    date: '2026-11-17', category: 'belonging', notice: '2026-11-16T21:00:00+09:00', question: true, scoped: true },
]
