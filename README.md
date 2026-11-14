# Family LINE Bot

家族の LINE グループで提出物や持ち物を管理するための Bot です。開発計画は [docs/PLAN.md](docs/PLAN.md) を参照してください。

## ローカル起動

Node.js 24 LTS と npm を用意し、PowerShell で実行します。

```powershell
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev
```

別の PowerShell で `Invoke-WebRequest http://localhost:8787/health` を実行すると HTTP 200 が返ります。

## 環境変数

ヘルスチェックとテストは環境変数なしで動きます。LINE 連携時は `.dev.vars.example` を `.dev.vars` にコピーし、`LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` を設定します。`.dev.vars` は Git 管理対象外です。

Webhook のパスは `POST /webhook/line` です。テスト用の LINE グループで Bot にメンションを送って操作メニューを開きます。

1. 「期限を追加」または「持ち物を追加」を押し、`11/20 水筒` や `2030-11-20 遠足の同意書` の形式で送ります。
2. 確認メッセージの「登録する」を押します。入力と確認の有効期限はそれぞれ10分です。
3. 「一覧を見る」で未完了のタスクを表示します。「完了」はその場で確定し、「削除」は確認ボタンを押すと確定します。

## 前日リマインダー

毎日 20:00 JST（Cron は `0 11 * * *` UTC）に、翌日が期限の未完了タスクをグループごとに1通の LINE メッセージで送ります。対象がない場合は送信しません。当日20時を過ぎて登録したタスクはその日の通知対象から外れます。LINE の文字数上限に達する場合は、収まらないタスクを「ほか N 件」と表示します。

通知本文と Retry Key は送信前に D1 に保存します。再試行 Cron は5分ごとに保存済み通知だけを確認します。HTTP 5xx・通信エラー・タイムアウトでは最低5分から間隔を倍にし、HTTP 429 では最低15分または `Retry-After` が指定する長い方の時間を待ちます。400・401・403 などの恒久エラーは自動再試行の対象外です。試行は初回を含め最大4回で、D1 に通知を保存してから24時間以内に限ります。

D1 が送信権を2分間確保し、1回の LINE リクエストは10秒でタイムアウトします。Worker が停止したり、送信結果を D1 に保存できなかったりして `pending` が残った場合は、送信権の期限後に同じ本文とキーで再試行します。LINE がそのキーの受理済みを示す HTTP 409 を返した場合は `sent` に更新します。

未配信が疑われるときは、対象日とログの処理段階を照合し、`notification_batches` の `status`、`last_error_kind`、`http_status`、`attempt_count`、`last_attempt_at`、`next_attempt_at` を確認してください。恒久エラーは設定やグループ参加状態を確認します。初回の D1 保存に失敗した場合はバッチが作成されず、自動再試行の対象外です。バッチがない場合や上限・期限に達した場合は、LINE グループで受信状況を確認してください。結果が不明なバッチの削除や Retry Key の作り直しは二重送信につながります。`sent` は LINE API がリクエストを受理した記録です。端末への到達は保証されません。[LINE の Retry Key](https://developers.line.biz/ja/docs/messaging-api/retrying-api-request/)

## 検証

```powershell
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

ローカルで通知を試すには、テスト用グループで翌日期限のタスクを登録した後、公開トンネルを停止してから、そのローカル D1 を使う Worker を `npm run dev -- --test-scheduled` で起動します。テスト用 LINE チャネルの設定で次を実行すると、その時点を基準に通知が送られます。同じ日に繰り返しても同じグループへの通知は1通です。

```powershell
Invoke-RestMethod 'http://localhost:8787/cdn-cgi/local/scheduled?cron=0+11+*+*+*&format=json'
```

## 手動デプロイ

1. Cloudflare に `npx wrangler login` でログインします。初回は `npx wrangler d1 create line-reminder-bot` で D1 を作成し、`wrangler.jsonc` のローカル検証用 `database_id` を作成した D1 の ID に置き換えます。
2. `npx wrangler d1 migrations apply DB --remote` で、`0003_notification_retries.sql` を含む未適用のマイグレーションをデプロイ先の D1 に適用します。ローカル D1 には `npx wrangler d1 migrations apply DB --local` を使います。
3. LINE Developers の「チャネル基本設定」で取得したチャネルシークレットと、「Messaging API設定」で取得したチャネルアクセストークンを、Git 管理外の `.env.production` に `LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` として設定します。
4. `npx wrangler deploy --secrets-file .env.production` で Worker と Secrets を設定します。
5. LINE Developers で Worker の HTTPS URL に `/webhook/line` を付けて登録し、「検証」が成功したら「Webhookの利用」とグループトークへの参加をオンにします。LINE Official Account Manager の応答メッセージをオフにして Bot をテスト用グループへ招待し、メニュー操作と 20:00 JST の通知を確認します。運用前に LINE の月間メッセージ通数も確認してください。
