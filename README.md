# Family LINE Bot

LINE グループで家族の提出物や持ち物を管理します。Bot にメンションして、次のように送ってください。日時は日本時間です。

| 操作 | 送信例 |
| --- | --- |
| 登録 | 12月20日までにレポート提出 |
| 短文で登録 | 教科書 11/20 ／ 履歴書書く 12/5 |
| 通知付き登録 | 12月20日締切のレポートを登録して。1週間前から毎日20時に通知して |
| 一覧 | 来週締切の提出物を教えて |
| 変更 | レポートの名前を作文にして、期限を12月23日に変更して |
| 完了・取り消し | レポート終わった ／ レポートを未完了に戻して |
| 削除・復元 | 水筒のタスクを削除して ／ 水筒のタスクを復元して |
| 通知の追加 | 英検申し込み、3日前に通知して |
| 通知の削除 | 7日前の通知はいらない |
| 通知の置き換え | やっぱ前日だけでいいや |
| 通知時刻だけ変更 | 通知を21時にして |
| 繰り返し | 2週間前から毎週月曜に通知して ／ 締切まで2日おきに通知して |
| 通知の停止・再開・確認 | このタスクの通知を止めて ／ 通知を再開して ／ いつ通知される？ |
| 今後のグループ既定値 | 今後登録するタスクはすべて前日21時に通知して |

メンションだけ、または Bot に「使い方」「ヘルプ」と送ると使い方が表示されます。「3日前に通知して」は既存の通知に追加し、「前日だけ」は置き換えます。通知の日だけを変更すると元の時刻を引き継ぎます。「前日の通知は外して」は前日の全時刻を削除し、「前日の8時だけ外して」は8時の通知を削除します。「通知して」で現在の通知設定を再開できます。

時刻を省略すると、指定した通知や引用したリマインダーの時刻、タスク内で最も多い時刻、グループの既定時刻、20:00の順に参照します。朝・夕方・夜の指定があればその時間帯に合う時刻を使い、候補がなければそれぞれ8:00・18:00・20:00です。結果への返信で「なんで20時にしたの？」「やっぱ9時にして」「今の追加はなしで」と伝えられます。

対象や締切など、必要な情報を決められない場合は質問します。質問は10分間有効です。質問への引用返信でも続けられ、「やっぱ今のなしで」で取り消せます。以前から時刻の回答待ちだった場合も「いつもの時間で」「任せる」「朝でいい」と答えられます。確定した返信は最後のやり取りから45分間、同じスレッドのタスクや通知を参照できます。引用返信で別のタスクを登録すると、その依頼から新しい会話が始まります。

Bot の登録結果・通知設定・リマインダーなどを LINE で引用すると、メンションなしで操作できます。たとえば登録結果に「2週間前にも」、リマインダーに「もう終わった」と返信します。一覧への返信ではタスク名を添えてください。LINE が引用元の ID を返さなかった場合や、ID の記録前に送った場合は、Bot をメンションして操作してください。

## Webhook の処理と再試行

署名済みの操作を D1 に保存してから LINE に HTTP 200 を返します。保存できなければ503を返します。LINE Developers で Webhook の再送を有効にしてください。保存済みの操作は普段すぐに処理し、Worker が中断しても毎分の Cron が続きを拾います。[LINE の Webhook 再送](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/#webhook-redelivery)

同じグループの保存済み操作は LINE のイベント時刻順に処理します。時刻が同じ場合は D1 の受信順を使います。先に新しい操作が確定すると、遅れて届いた古い操作は終了し、返信できる場合は再操作を案内します。同じグループでは、処理待ちの先頭が再試行中だと後続も待ちます。

AI のタイムアウト・接続障害や D1 の処理エラーは、初回を含め最大3回、受信から最大15分まで再試行します。解釈できない入力や古い操作は再試行しません。状態を調べる場合は `webhook_inbox` の `event_id`、`status`、`attempts`、`last_error` を確認してください。処理完了時は入力と返信トークンを消去します。

操作結果はタスク変更と同じ D1 バッチで Outbox に保存します。受信から50秒以内に送信時間を確保できるときは Reply を使い、期限が近い場合や LINE が Reply を明示的に拒否した場合は元のグループへの Push に切り替えます。AI の再試行を使い切った場合も Push で再操作を案内します。結果が不明な場合は、タスク一覧で確認するよう案内します。[LINE の応答トークン](https://developers.line.biz/ja/reference/messaging-api/#send-reply-message)

Reply がタイムアウトした場合や送信中に Worker が停止した場合、すでに届いた可能性があるため自動で Push に切り替えません。Push は同じ本文と Retry Key を使い、確定から1時間以内に最大4回試行します。429 は最低15分と `Retry-After` の長い方を待ちます。LINE の受理は端末への到達を保証しません。通知が見えない場合は、操作を送り直す前に一覧を確認してください。[LINE の再試行仕様](https://developers.line.biz/ja/docs/messaging-api/retrying-api-request/)

毎分の Cron が Inbox、結果通知、予定リマインダーを処理します。Webhook のバックグラウンド処理と Cron はそれぞれ25秒の予算を持ち、残り時間が少なければ後続の操作・通知を次回に回します。推論・LINE API の上限は `AI_TIMEOUT_MS`（最大12,000ミリ秒）と `LINE_TIMEOUT_MS`（最大10,000ミリ秒）で個別に短縮できます。D1 への処理中に中断された場合は、処理権の期限後に再開します。

確認時は `webhook_inbox` の `event_id`、`status`、`attempts`、`last_error` と、`operation_result_outbox` の `status`、`channel`、`push_attempts`、`available_at`、`last_error` を照合します。結果通知が終端状態になった時点で本文と Reply Token を消去し、取得できた `line_message_id` と、対象が特定できる場合は `task_id` を引用返信用に残します。

## 通知ルール

- 既定では登録時に期限まで8日以上あれば7日前と前日、2〜7日なら前日の20:00に通知します。当日・翌日が期限の場合も、同じ計算から未来の時刻だけが残ります。時刻未指定は20:00、「朝」は08:00、「夜」は20:00です。
- 日付ごとの指定は最大10枠、繰り返しは最大4時刻と曜日または日間隔を指定できます。期限からの相対日数は最大366日です。「締切まで毎日」のような登録日からの繰り返しは長期タスクにも使えます。
- 「にも」は既存の設定に追加し、「前日だけにして」は前日だけに置き換えます。「朝8時にも」は今の通知日に08:00を追加します。繰り返しを続けながら単発の通知を足したり除外したりできます。最後の1件を削除すると通知が停止し、再開すると停止直前の設定に戻ります。
- 「8時じゃなくて9時にして」は、現在08:00の通知がなくても、そのタスクの全通知を09:00に変更します。「7日前の通知だけ9時にして」「さっき追加した通知だけ9時にして」のように指定すると、指定した通知を変更します。引用でタスクを指定できます。個別リマインダーを引用して「この通知だけ」と送ると、その送信日時を使います。通知設定などのまとめを引用した場合や、対象が複数ある場合は確認します。
- 追加の時刻を省略した場合は、直近で特定できる通知、現在の単一時刻、グループ設定の順に参照し、混在して判断できない場合は聞き返します。停止中に「3日前にも通知して」などと頼むと、未来の予定から再開します。「設定だけ」「停止したまま」の指定があれば、設定を保存して停止を維持します。
- 「11/16 0:35にも通知して」のような日付指定は、日本時間のその日時に固定します。「3週間前」などは締切を変えると追従します。検索・削除・時刻変更では実際の送信日時で照合するため、「12月7日の20時の通知を消して」で、期限が12月14日の「7日前 20:00」を削除できます。同じ日時への追加は1件にまとめます。年の省略は現在の日本の年を基準にし、11・12月から指定する1・2月は翌年です。過ぎた日時への追加は受け付けません。
- 「全部9時にして、前日の通知だけ20時のままにして」のように、同じタスクへの複数の通知変更を1メッセージで送れます。すべての操作を検証してからまとめて保存します。
- 各タスクについて毎回次の1件だけを計算し、毎分の Cron が対象を処理します。通知はタスクごと・予定時刻ごとに1件です。追加・部分削除で残った通知は、再試行中の本文と Retry Key を維持します。停止・完了・削除などで送信対象外になった通知は再試行を打ち切ります。送信権取得後にすでに開始した LINE へのリクエストは取り消せません。
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

ローカル Cron を試すには、公開トンネルを停止し、タスクを登録した環境を `--test-scheduled` 付きで起動します。通常環境では `npm.cmd run dev -- --test-scheduled` を使います。通知予定時刻になったら、起動ログの `Ready on` に出たポートで以下を実行します。テスト用グループ・チャネルとローカル D1 を使用してください。

```powershell
Invoke-RestMethod 'http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json'
npm.cmd run typecheck
npm.cmd test
npx.cmd wrangler deploy --dry-run
```

テストはモック AI・LINE API とローカル D1 を使います。設定済みの Gemini キーで試す場合は以下の試用環境を使います。

Workers AI を利用できるアカウントで Wrangler にログインすると、合成した会話シナリオで単発登録と複数ターンの会話を検証できます。ローカル D1 と LINE API のモックを使用します。`-t 'Workers AI dialogue.*review'` でレビュー指摘の8件に絞れます。一部にはモデルへ回答形式を指定する検証が含まれます。評価時だけ合成入力に対するモデルの生出力と D1 に反映された予定が表示されます。既存の79ケースのIntent評価で全件を実モデルに送る場合は `MODEL_ONLY_INTENT_EVAL=1` を併用します。

```powershell
$env:RUN_REAL_DIALOGUE_EVAL = '1'
npm.cmd test -- tests/webhook.test.ts -t 'Workers AI dialogue'
Remove-Item Env:RUN_REAL_DIALOGUE_EVAL
```

### Gemini を試す

Gemini Developer API の `gemini-3.5-flash-lite` を使います。テキストの入出力は無料枠で利用でき、実際の上限はプロジェクトごとに Google AI Studio で確認できます。Google の無料サービスの規約に従い、試用には個人情報や機密情報を含まない合成メッセージを使ってください。[料金](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) · [利用上限](https://ai.google.dev/gemini-api/docs/rate-limits) · [利用規約](https://ai.google.dev/gemini-api/terms)

`.dev.vars.example` を `.dev.vars.gemini` にコピーし、テスト用の LINE シークレット2件と、Google AI Studio で作った `GEMINI_API_KEY` を設定します。Gemini のモデルを変更する場合は `GEMINI_MODEL` を指定します。[API キーの作成](https://aistudio.google.com/apikey)

```powershell
npx.cmd wrangler d1 migrations apply DB --local --env gemini
npm.cmd run dev -- --env gemini --local
```

`gemini` 環境では Gemini を優先し、試用専用のローカル D1 を使います。ローカル Worker とテスト用 LINE グループを接続し、Bot にメンションして登録や通知変更を試せます。Workers AI への切り替えも試す場合は、Wrangler にログインして `npm.cmd run dev -- --env gemini` で起動します。Workers AI はリモートで実行され、D1 はローカルです。

予定通知や Inbox の再試行を確認する場合は、公開トンネルを停止し、使っている起動コマンドに `--test-scheduled` を追加します。起動ログに `DB (line-reminder-bot-gemini)` が表示されたことを確認し、`Ready on` に出たポートで前節の Cron 確認コマンドを実行してください。

実モデルの疎通確認には `GEMINI_API_KEY` だけ設定すれば、以下の合成ケースを実行できます。

```powershell
$env:RUN_REAL_GEMINI_EVAL = '1'
$env:MODEL_ONLY_INTENT_EVAL = '1'
node --env-file=.dev.vars.gemini node_modules/vitest/vitest.mjs run tests/intent-eval.test.ts -t 'Gemini API.*さっきのやつ、14日前も'
Remove-Item Env:RUN_REAL_GEMINI_EVAL, Env:MODEL_ONLY_INTENT_EVAL
```

精度比較には同じ `tests/intent-eval.test.ts` を使います。Gemini で全件を評価するには `-t 'Gemini API'` を指定します。Workers AI では `RUN_REAL_INTENT_EVAL=1` と `MODEL_ONLY_INTENT_EVAL=1` を設定して `-t 'Workers AI'` を指定します。どちらも操作の解釈と、通知変更後の予定を同じ期待値で検証します。

## 設定と本番反映

Workers AI では思考生成オフを採用しています。Gemini 3.5 Flash-Lite はモデル既定の `minimal` で実行します。

- `wrangler.jsonc` の `ai.binding` は `AI`、`vars.AI_MODEL` の初期値は `@cf/qwen/qwen3.8-27b` です。このモデルでは応答時間を抑えるため `reasoning_effort: "low"` と `chat_template_kwargs.enable_thinking: false` を指定します。日本語と JSON 出力をサポートする Workers AI モデルを指定してください。Workers AI バインディングはアカウントに紐づき、専用の API キーを Worker に置く必要はありません。ローカルで実推論を試す場合は Workers AI を利用できるアカウントで `npx.cmd wrangler login` してください。[モデル仕様](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)
- 既定の `AI_PROVIDER=auto` は、`GEMINI_API_KEY` があれば Gemini を優先します。利用枠超過などで Gemini の呼び出しが失敗した場合は、残りの推論時間で Workers AI を試します。時間切れの場合は Inbox の再試行で Workers AI を呼び出します。キーが未設定の場合は最初から Workers AI を使用します。推論先を固定するには `AI_PROVIDER=gemini` または `AI_PROVIDER=workers-ai` を指定します。
- `ai_unavailable` は推論 API の呼び出し失敗です。Gemini から HTTP エラーが返った場合、Worker のログにステータスコードが出ます。Workers AI の旧モデル `@cf/qwen/qwen3-30b-a3b-fp8` は2026年11月20日に提供終了となり、エラー5028を返します。Workers AI でこのエラーが出た場合は、`AI_MODEL` の上書き設定を確認してください。[提供終了の案内](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/)
- 承認後、`wrangler.jsonc` の D1 ID を実際のものに置き換え、`npx.cmd wrangler d1 migrations apply DB --remote` で `0009` までの未適用分を適用します。ローカルでは `npx.cmd wrangler d1 migrations apply DB --local` を使います。既存のタスク・送信履歴は保持されます。新バージョンで旧2本の Cron が無効になり、毎分 Cron が有効になったことを確認します。移行前に旧方式で同日の前日通知が受理されたか不明な場合も、重複防止のため同じ前日20時の枠をスキップします。
- LINE Secrets を Git 管理外の `.env.production` に設定して `npx.cmd wrangler deploy --secrets-file .env.production` で手動反映します。Gemini を有効にする場合は `GEMINI_API_KEY` も同じファイルに設定します。テストグループで登録・通知・引用返信を確認後、家族グループで使います。通知の通数は LINE のプラン、推論の上限は各 AI プロバイダーの利用枠に応じます。[LINE の料金](https://developers.line.biz/ja/docs/messaging-api/pricing/) · [Workers AI 料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)
