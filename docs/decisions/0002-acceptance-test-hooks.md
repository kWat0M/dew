# 0002: 受け入れテストが頼る外部仕様

- 日付: 2026-10-15
- フェーズ: 1
- 状態: 採用

フェーズ1の受け入れテストを実装より先に書くため、仕様にない次の細部をテストの前提として決めた。`~/.cache/dew/server.json` には `pid`・`port`・`token` を書く。`/?token=` は Cookie を発行して `/` へリダイレクトする。`/api/*` の `path` は絶対パスで、相対パスは閲覧範囲の起点からの位置とみなす。変換は `/api/media?path=&transcode=1&seg=N` で6秒単位のセグメントを返し、キャッシュの当否を `x-dew-cache: hit|miss` ヘッダで示す。UI は `data-testid`(`col-parent`・`col-current`・`col-preview`・`player-window`・`start-overlay`)と、項目の `role="option"`・`data-name` で特定する。`$HOME` が `--root` の外にあるときは、Home を `--root` の位置で開く。テストは並列に動かすので `--port` で空きポートを渡し、開発コンテナの `DEW_PUBLIC_*` を持ち込まないよう環境変数を空にして起動する。OCR や画像比較は使わず、フレーム番号は素材の2進ブロックを画素から読むことにした。
