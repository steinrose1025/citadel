# CITADEL — 陣取り戦略ボード（ネット対戦対応）

6×6 の盤面で領地を奪い合う戦略ゲームです。CPU 対戦・ローカル2人対戦に加えて、
**ネット対戦**（ロビー方式・手番の持ち時間60秒）に対応しています。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | ゲーム本体（UI・描画・CPU・ネット対戦クライアント） |
| `game-logic.js` | 盤面ルールの共有モジュール（ブラウザ／サーバー両用） |
| `server.js` | ネット対戦サーバー（Express + Socket.IO） |
| `package.json` | 依存パッケージとスクリプト |
| `test/online.test.js` | サーバーの結合テスト |

CPU・ローカル対戦だけなら `index.html` を直接開くだけで動きます（サーバー不要）。
**ネット対戦にはサーバー（`server.js`）の起動が必須**です。

## 動かし方（ローカル）

```bash
npm install      # 初回のみ（express, socket.io を取得）
npm start        # http://localhost:3000 で起動
```

ブラウザで `http://localhost:3000` を開き、対戦モードで「ネット対戦」を選択します。

### 遊び方（ネット対戦）

1. 対戦モードで **「ネット対戦」** を選ぶとロビー画面が開きます。
2. **名前を入力** して「ロビーに入る」。
3. **部屋を作る**（手数を選択）か、一覧から **既存の部屋に「入る」**。
4. 2人そろうと自動で対局開始。先手は青です。
5. 各手番の **持ち時間は60秒**。残り時間が画面に表示され、**60秒を超えると時間切れで敗北**になります。
6. 対局中に相手が退出した場合は、残った側の勝ちになります。

## サーバーへのデプロイ

Node.js が動くホスティング（VPS / Render / Railway / Fly.io など）に一式を配置し、

```bash
npm install --omit=dev
npm start
```

を実行します。待ち受けポートは環境変数 `PORT` で指定できます（未指定時は 3000）。
リバースプロキシ（Nginx 等）を使う場合は、WebSocket のアップグレードを通す設定にしてください
（テンプレート: `deploy/nginx-citadel.conf`）。

PM2 での常駐起動には `ecosystem.config.js` を使います（`pm2 start ecosystem.config.js`）。

リバースプロキシ設定テンプレート:
- `deploy/apache-citadel-subpath.conf` … **Apache** で既存ドメインのサブパスに公開（vhostへ追記）
- `deploy/citadel.htaccess` … Apache で vhost を編集できない場合の `.htaccess` 版
- `deploy/nginx-citadel-subpath.conf` … **Nginx** でサブパス公開する場合の `location`
- `deploy/nginx-citadel.conf` … Nginx で独自ドメイン/サブドメインを丸ごと割り当てる場合の server ブロック

> クライアント(`index.html`)は表示中URLから配信パスを自動判別するため、ルート公開・サブパス公開のどちらでもコード変更なしで動作します。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `TURN_MS` | `60000` | 手番の持ち時間（ミリ秒）。通常は変更不要（テスト用） |

## テスト

```bash
npm test
```

部屋作成・入室・手番制御・時間切れ敗北・切断時の勝敗を自動検証します。
