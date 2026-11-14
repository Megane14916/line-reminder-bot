# Family LINE Bot

家族の LINE グループで提出物や持ち物を管理するための Bot です。開発計画は [docs/PLAN.md](docs/PLAN.md) を参照してください。

## ローカル起動

Node.js 24 LTS と npm を用意し、PowerShell で実行します。

```powershell
npm ci
npm run dev
```

別の PowerShell で `Invoke-WebRequest http://localhost:8787/health` を実行すると HTTP 200 が返ります。

## 環境変数

ヘルスチェックとテストは環境変数なしで動きます。LINE 連携時は `.dev.vars.example` を `.dev.vars` にコピーし、`LINE_CHANNEL_SECRET` と `LINE_CHANNEL_ACCESS_TOKEN` を設定します。`.dev.vars` は Git 管理対象外です。

Webhook のパスは `POST /webhook/line` です。テスト用の LINE グループで Bot にメンションを送ると、操作メニューが表示されます。各ボタンは案内メッセージを返します。

## 検証

```powershell
npm run typecheck
npm test
```
