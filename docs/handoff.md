# 引き継ぎ(2026-10-16 時点)

次のセッションが、この文書だけで続きを始められるようにまとめる。仕様は `docs/spec.md`、判断の記録は `docs/decisions/` が正。

## 1. 今どこにいるか

### ブランチ

| ブランチ | 状態 |
|---|---|
| `main` | フェーズ1・操作画面の改訂・フェーズ2まで入っている(PR #1〜#3 をユーザーが Web でマージ。`28818f6`) |
| `phase-2-followup` | GitHub に push 済み、**未マージ**。キャンバスのバーの並び、リモート確認の手順で `.env` を使う修正(`ea6e6b1`) |
| `phase-3` | `phase-2-followup` から切った。**手元だけで、push していない**。フェーズ3の作業はすべてここ |

- PR はユーザーが GitHub の Web で作ってマージしている(`gh` は未ログインで、`gh auth login` はユーザーが面倒と判断)。こちらは push までを行い、Web でのマージを頼む
- `git push` と `git merge` は `.claude/settings.json` で確認が出る設定。ユーザーの許可を得てから行う

### フェーズ3(ライブ描画)の受け入れ基準(spec 11章)

| 基準 | 状態 | テスト |
|---|---|---|
| 1. `dew run python3 tests/apps/counter.py` でウィンドウがキャンバスに出る | 達成 | E2E(Chrome / Firefox)、Rust 結合 |
| 2. 2つの窓で2つのウィンドウが出る | 達成 | E2E |
| 3. 1080p60 で受信 fps 55 以上、遅延 150 ms 以下 | **単独では達成、全体実行で失敗**(下の「未解決 1」) | E2E(`fixme` にしてある) |
| 4. 440 Hz がブラウザで 440 Hz として検出される | 達成 | E2E、Rust 結合 |
| 5. 入力モードのキーだけがアプリに届く(`Ctrl+]` で抜ける) | 達成 | E2E |
| 6. cv2・matplotlib・pygame のサンプルが表示される | 達成 | E2E |

最新の結果(`460aeeb` の時点): Rust 59件、web 単体 16件、E2E 94件がすべて通る(基準3を含む2件は skip)。

## 2. フェーズ3で作ったもの

流れ: `dew run` → サーバが仮想ディスプレイ(Xvfb)と音声サーバ(pulseaudio)のセッションを1つ作る → アプリのウィンドウを監視し、ウィンドウごとに ffmpeg で H.264 にして `/ws/live/{id}` で配る → ブラウザが WebCodecs で復号して canvas に描く。音は null-sink の monitor を ffmpeg で Opus にして `/ws/live-audio` で配る。入力は `/ws/live/{id}` で受け取って XTest で注入する。

| 場所 | 中身 |
|---|---|
| `crates/capture/src/session.rs` | Xvfb(`:100` から空き、3840x2160)と pulseaudio(null-sink `dew`)。止めるときは SIGTERM で、終わるまで待つ |
| `crates/capture/src/monitor.rs` | x11rb でトップレベルのウィンドウを監視。重ならない位置に置き直す。名前・大きさ・PID を知らせる |
| `crates/capture/src/stream.rs` | ウィンドウごとの ffmpeg(`x11grab -window_id` → libx264 zerolatency、AUD 入り)。最後のキーフレーム以降を取っておく |
| `crates/capture/src/audio.rs` | セッション音声(ffmpeg の pulse 入力 → 10 ms 単位の Opus → Ogg を区切る) |
| `crates/capture/src/input.rs` | KeyboardEvent.key → keysym、XTest でキー・マウス、XSetInputFocus、ウィンドウの大きさの変更 |
| `crates/server/src/live.rs` | `/api/live/session`、`/ws/live/{id}`(映像と入力)、`/ws/live-audio`、一覧を `/ws/events` へ |
| `crates/dew/src/main.rs` | `dew run <コマンド>`(終了コードを返す)、`dew env` |
| `web/src/canvas/LiveWindow.tsx` | ライブウィンドウ(WebCodecs、入力モード、`I` の文字列送信、終わったら「終了」) |
| `web/src/canvas/liveAudio.ts` | セッション音声の再生(50 ms 先に予約)と `window.dewTest.audioPeakHz()` |
| `tests/apps/` | テスト用アプリ。counter.py はフレーム番号と描いた時刻を画素に焼き込み、440 Hz を鳴らし、受け取ったキーを記録 |

決めたこと(ADR): 0009 取り込みとエンコードは ffmpeg に任せる(openh264 は組み込まない)/ 0010 音声はまずセッション全体で1本。

## 3. 未解決・次にやること(上から優先)

1. **基準3が全体実行で落ちる**: `npx playwright test -g 1080p --project chrome` 単独なら 60.5 fps・遅延 51 ms で通るが、E2E 全体を並列に流すと 4.5 fps まで落ちる。CPU の取り合い(1080p の libx264 と、2つのブラウザでの復号)か、ヘッドレス Chrome が裏のページを間引いているのかは未調査。調べて直すか、性能のテストだけを別の Playwright プロジェクト(workers 1、ほかの後)で流す。直したら `tests/e2e/specs/phase3.spec.ts` の `fixme` を外す
2. **`w r` のブラウザ側**: サーバは `LiveInput::Resize` を受けられる(`460aeeb`)。残りは、ウィンドウ操作モードの `r` と操作パネルのボタン、LiveWindow の表示領域の大きさ(CSS px × devicePixelRatio)を送る処理、E2E。キー一覧とヒントへの追加を忘れると `web/src/keymaps.test.ts` が落ちる
3. **一時的な窓(メニュー・ツールチップ)**: spec 7.9 では親の映像に重ねて出すが、今は監視が override-redirect の窓を無視しているので出ない
4. **音をウィンドウごとに分ける**(spec 7.6、ADR 0010): PID はすでに取っている(`WindowInfo.pid`)
5. **フェーズ3の終わりの報告**: 受け入れ基準の達成状況と、人が見た目・操作感を確かめる手順。そのあと `phase-3` を push して、ユーザーに Web で PR・マージを頼む
6. ユーザーの確認待ち:
   - Zen で2本並べたとき、フォーカス中の右側の動画が黒くなる問題への対策(フォーカスで影と重なり順を変えない)が効いたか
   - リモートサーバでの2コンテナの確認(`docs/manual/remote-test.md`)。前回は URL が「サイトが見つからない」で開けなかった。ホスト名が Windows から引けていない可能性が高い、と説明済み(Jupyter の URL のホスト部分を使う、`Test-NetConnection` で確かめる)
7. 開発用コンテナを作り直すと Playwright の Firefox(`~/.cache/ms-playwright`)が消える。Dockerfile に `playwright install firefox` を足す必要がある(コンテナの作り直しは人がホストで行う)
8. `tests/fixtures/komasan.png` はユーザーが置いたファイル。消さない(`gen-fixtures.sh` もディレクトリを消さないようにしてある)

## 4. 作業の決まりと注意

- **コミットはテストの結果を確かめてから**。このセッションでは、テストとコミットを `;` でつないで実行し、失敗したままコミットしたことが3回あった。検査とコミットは別のコマンドにする
- 確認のコマンド:
  ```bash
  cargo fmt && cargo clippy --all-targets -q -- -D warnings
  cargo nextest run
  pnpm -C web lint && pnpm -C web test
  pnpm -C tests/e2e test          # web のビルドと cargo build も中でやる。Chrome と Firefox の両方
  ```
- protocol の型を変えたら `cargo nextest run -p dew-protocol` で `web/src/protocol/` を作り直す(web の型検査の前に)
- E2E は並列で流れるので、負荷が高いときだけ落ちるテストがある。直すときは `--repeat-each` や全体の連続実行で確かめる。E2E が失敗すると、`dew run` の出力とサーバのログの末尾がテストの出力に出る(`tests/e2e/lib/dew.ts`)
- React の lint(React Compiler)は、描画中に ref を読む書き方を通さない。`useCallback` の依存に毎回作り直されるオブジェクトを入れると、動画の読み込みが毎回やり直される不具合になった(2回起きた)。変わらない関数だけを依存に入れる
- 開発用コンテナの `/tmp/.X11-unix` は WSLg と共有していて Xvfb が使えない。Xvfb は抽象名前空間のソケットで待ち受けるので、つなぐ側もそこを見る(`session.rs` の `x_listening`、`monitor.rs` の `connect`)
- pulseaudio は `--realtime=false --high-priority=false` を付けないと D-Bus を待って起動が遅れる
- テストが読む口: `data-decoded`(ライブウィンドウの復号したフレーム数)、`data-input`(入力モード)、`window.dewTest.audioPeakHz()`、`data-testid="live-window"`

## 5. ユーザーについて

- 文章・コメント・コミットメッセージは日本語。UI の文言は `web/src/i18n/ja.ts` に集める
- vimmer だが、友人のために文字入力以外の全操作をマウスでもできるようにしたい。重ねて出す画面には閉じるボタンを付ける
- Zen ブラウザを使う(Firefox 系)。E2E は Chrome と Firefox の両方で回す
- 見た目は試しながら決めたい。仕様にない UI の判断は既定に近い案で進め、ADR に残して報告する
- このプロジェクトでは、ファイルの編集やコマンドの実行に事前の確認は要らない(`CLAUDE.local.md`)。ただし、仕様の矛盾、受け入れ基準を満たせないと分かったとき、新しい外部依存(apt など)は止めて聞く。push とマージは許可を得てから
