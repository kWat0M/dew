# dew

コンテナ内のファイルと GUI アプリの描画を Windows のブラウザで見るツール。
仕様は docs/spec.md が正。迷ったら docs/spec.md → docs/decisions/ の順で確認する。

## 構成
- crates/: Rust(サーバ、CLI、キャプチャ)。web/: React + TypeScript + Vite
- 通信の型は crates/protocol で定義し、ts-rs で web/src/protocol/ に出力する。TS 側の型を手で書かない
- 開発はこのリポジトリの開発用コンテナ(Dockerfile / compose/compose.yaml / dev.sh)の中で行う。コンテナ内に docker はない

## コマンド
- ビルド: cargo build / pnpm -C web build
- テスト: cargo nextest run / pnpm -C web test / pnpm -C tests/e2e test
- 素材生成: scripts/gen-fixtures.sh
- 整形と検査: cargo fmt && cargo clippy --all-targets -- -D warnings / pnpm -C web lint
- 配布用ビルド: cargo zigbuild --release --target x86_64-unknown-linux-musl(DuckDB の C++ を zig でビルドする。scripts/release.sh)

## 進め方
- 作業はフェーズ順(docs/spec.md 9章)。各フェーズの受け入れ基準(11章)を自動テストにしてから実装する
- フェーズごとにブランチ(phase-1 など)を切り、1機能ごとにテストを通してコミットする。main へは直接コミットしない
- 仕様にない細かい判断は、仕様の既定値に近い案で進め、docs/decisions/NNNN-タイトル.md に理由を1段落で残す。作業は止めない
- 止めて人に聞くのは次の場合だけ: 仕様同士が矛盾する / 受け入れ基準を満たせないと分かった / 新しい外部依存(apt パッケージ等)が必要
- フェーズの終わりに、受け入れ基準の達成状況と、人が見た目・操作感を確認する手順を短くまとめて報告する

## 守ること
- プログラム無改変が原則。ライブ描画のためにユーザーのコードを書き換える機能は作らない
- ffmpeg はライブラリとしてリンクせず CLI で呼ぶ
- ブラウザの Ctrl 系ショートカットをキーマップに使わない(入力モードを抜ける Ctrl+] だけ例外)。キー判定は KeyboardEvent.key が基本、IME 有効時(key が Process)だけ code で判定
- UI は Material Design 3 のトークン(web/src/theme/)だけで色・角丸・影を指定する。直接の色指定をしない
- UI の文言は日本語で、1ファイル(web/src/i18n/ja.ts)に集約する。コード内の識別子は英語、コメント・コミットメッセージ・ADR は日本語
- E2E は Playwright の channel: 'chrome'(同梱 Chromium は H.264 非対応)と、Playwright の Firefox(`playwright install firefox` で入れる)の2つで実行する
- テストで GUI が必要なときは Xvfb を使い、WSLg の DISPLAY に依存しない
- Vite の開発サーバは server.host を 0.0.0.0、ポート 5173 にする(Windows のブラウザから開くため)
