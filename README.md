# Family LINE Bot

LINE グループで家族の提出物や持ち物を管理します。Bot にメンションして、次のように送ってください。日時は日本時間です。

| 操作 | 送信例 |
| --- | --- |
| 登録 | 12月20日までにレポート提出 |
| 通知付き登録 | 12月20日締切のレポートを登録して。1週間前から毎日20時に通知して |
| 一覧 | 来週締切の提出物を教えて |
| 変更 | レポートの名前を作文にして、期限を12月23日に変更して |
| 完了・取り消し | レポート終わった ／ レポートを未完了に戻して |
| 削除・復元 | 水筒のタスクを削除して ／ 水筒のタスクを復元して |
| 通知設定 | やっぱり3日前と当日の朝8時に通知して |
| 繰り返し | 2週間前から毎週月曜に通知して ／ 締切まで2日おきに通知して |
| 通知の停止・再開・確認 | このタスクの通知を止めて ／ 通知を再開して ／ いつ通知される？ |
| 今後のグループ既定値 | 今後登録するタスクはすべて前日21時に通知して |

メンションだけを送ると使い方が表示されます。同名候補を聞かれたときは、表示された `#番号` を10分以内に返信します。「さっきのタスク」「やっぱり」は同じグループ・送信者の直近10分の操作を参照します。削除済みのタスクも復元できます。過去のタスクは復元しても過ぎた通知は送りません。

Bot の通知を LINE の引用返信機能で引用し、「終わった」「完了」「✅」などと送ると対象タスクを完了できます。引用元の ID が記録できなかった場合は、Bot にメンションしてタスク名と「完了」を送ってください。

## Webhook の処理と再試行

署名済みの操作を D1 に保存してから LINE に HTTP 200 を返します。保存できなければ503を返します。LINE Developers で Webhook の再送を有効にしてください。保存済みの操作は普段すぐに処理し、Worker が中断しても毎分の Cron が続きを拾います。[LINE の Webhook 再送](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/#webhook-redelivery)

同じグループの保存済み操作は LINE のイベント時刻順に処理します。時刻が同じ場合は D1 の受信順を使います。先に新しい操作が確定すると、遅れて届いた古い操作は終了し、返信できる場合は再操作を案内します。同じグループでは、処理待ちの先頭が再試行中だと後続も待ちます。

AI のタイムアウト・接続障害や D1 の処理エラーは、初回を含め最大3回、受信から最大15分まで再試行します。解釈できない入力や古い操作は再試行しません。状態を調べる場合は `webhook_inbox` の `event_id`、`status`、`attempts`、`last_error` を確認してください。処理完了時は入力と返信トークンを消去します。

LINE への返信はタスク変更とは別に行います。返信は受信から50秒未満で試行するため、Cron で復旧した操作は返信が届かない場合があります。結果が見えない場合は、同じ操作を送り直す前に一覧を確認してください。[LINE の応答トークン](https://developers.line.biz/ja/reference/messaging-api/#send-reply-message)

## 通知ルール

- 既定では登録時に期限まで8日以上あれば7日前と前日、2〜7日なら前日の20:00に通知します。当日・翌日が期限の場合も、同じ計算から未来の時刻だけが残ります。時刻未指定は20:00、「朝」は08:00、「夜」は20:00です。
- 日付ごとの指定は最大10枠、繰り返しは最大4時刻と曜日または日間隔を指定できます。期限からの相対日数は最大366日です。「締切まで毎日」のような登録日からの繰り返しは長期タスクにも使えます。
- 各タスクについて毎回次の1件だけを計算し、毎分の Cron が対象を処理します。通知はタスクごと・予定時刻ごとに1件です。停止・完了・削除・ルール変更は旧バージョンの未送信分を無効にします。送信権取得後にすでに開始した LINE へのリクエストは取り消せません。
- 送信権は2分、リクエストのタイムアウトは10秒です。本文と Retry Key を保存し、5xx・通信失敗には5・10・20分の間隔で最大4回（初回込み）試行します。429 は最低15分または `Retry-After` の長い方を待ちます。予定から1時間後または JST の日付が変わる時点のうち早い方で送信を打ち切ります。
- `sent` は LINE API の受理を示します。受理済み409でもメッセージIDがないことがあります。結果不明の行を消したり Retry Key を作り直したりすると重複送信につながります。障害時は `reminder_occurrences` の `status`、`last_error_kind`、`attempt_count`、`last_attempt_at` を確認してください。

## ローカル開発と検証

Node.js 24 LTS と npm を使用します。PowerShell で実行します。

```powershell
npm.cmd ci
npx.cmd wrangler d1 migrations apply DB --local
npm.cmd run dev
```

`GET /health` と `POST /webhook/line` が公開ルートです。LINE 実機確認ではテスト用チャネルの `LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` を、Git 管理外の `.dev.vars` に設定します。テスト用 HTTPS URL の末尾に `/webhook/line` を付けて LINE Developers で登録・検証し、Webhook とグループ参加を有効にします。標準の自動応答は LINE Official Account Manager でオフにしてください。

ローカル Cron は公開トンネルを停止した状態で `npm.cmd run dev -- --test-scheduled` を起動し、通知予定時刻に以下を実行します。テスト用グループ・チャネルとローカル D1 を使用してください。

```powershell
Invoke-RestMethod 'http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json'
npm.cmd run typecheck
npm.cmd test
npx.cmd wrangler deploy --dry-run
```

テストはモック AI・LINE API とローカル D1 を使います。ローカル Worker で実際にメンション操作をすると Workers AI のリモート推論が必要です。

## 設定と本番反映

- `wrangler.jsonc` の `ai.binding` は `AI`、`vars.AI_MODEL` の初期値は `@cf/qwen/qwen3-30b-a3b-fp8` です。日本語と JSON 出力をサポートする Workers AI モデルを指定してください。Workers AI バインディングはアカウントに紐づき、専用の API キーを Worker に置く必要はありません。ローカルで実推論を試す場合は Workers AI を利用できるアカウントで `npx.cmd wrangler login` してください。[モデル仕様](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
- 承認後、`wrangler.jsonc` の D1 ID を実際のものに置き換え、`npx.cmd wrangler d1 migrations apply DB --remote` で `0005` までの未適用分を適用します。既存のタスク・送信履歴は保持されます。新バージョンで旧2本の Cron が無効になり、毎分 Cron が有効になったことを確認します。移行前に旧方式で同日の前日通知が受理されたか不明な場合も、重複防止のため同じ前日20時の枠をスキップします。
- LINE Secrets を Git 管理外の `.env.production` に設定して `npx.cmd wrangler deploy --secrets-file .env.production` で手動反映します。テストグループで登録・通知・引用返信を確認後、家族グループで使います。通知の通数は LINE のプラン、推論は Workers AI の利用量に応じます。[LINE の料金](https://developers.line.biz/ja/docs/messaging-api/pricing/) · [Workers AI 料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)
