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

通知本文と Retry Key は送信前に D1 に記録されます。LINE API のエラーはログと `notification_batches` に記録し、自動再送は行いません。送信中の中断で `pending` が残った場合も、同じグループ・対象日への自動送信は行いません。

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
2. `npx wrangler d1 migrations apply DB --remote` でデプロイ先の D1 にマイグレーションを適用します。
3. LINE Developers の「チャネル基本設定」で取得したチャネルシークレットと、「Messaging API設定」で取得したチャネルアクセストークンを、Git 管理外の `.env.production` に `LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` として設定します。
4. `npx wrangler deploy --secrets-file .env.production` で Worker と Secrets を設定します。
5. LINE Developers で Worker の HTTPS URL に `/webhook/line` を付けて登録し、「検証」が成功したら「Webhookの利用」とグループトークへの参加をオンにします。LINE Official Account Manager の応答メッセージをオフにして Bot をテスト用グループへ招待し、メニュー操作と 20:00 JST の通知を確認します。運用前に LINE の月間メッセージ通数も確認してください。
