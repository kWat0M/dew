# 引き継ぎ(2026-10-18 時点)

次のセッションが、この文書だけで続きを始められるようにまとめる。仕様は `docs/spec.md`、判断の記録は `docs/decisions/` が正。

## 1. 今どこにいるか

### ブランチ

| ブランチ | 状態 |
|---|---|
| `main` | フェーズ1〜3 が入っている(PR #4 で `phase-3` をマージ。`6a69af9`) |
| `phase-4` | `origin/main` から切った。2026-10-18 に push 済み。ユーザーが Web で PR・マージする |

- PR はユーザーが GitHub の Web で作ってマージしている(`gh` は未ログイン)。こちらは push までを行い、Web でのマージを頼む
- `git push` と `git merge` は `.claude/settings.json` で確認が出る設定。ユーザーの許可を得てから行う

### フェーズ4(精度・記録)の受け入れ基準(spec 11章)

| 基準 | 状態 | テスト |
|---|---|---|
| 1. 精度モードの cv2.imshow が送信元の配列と画素単位で一致する | 達成 | E2E(`phase4.spec.ts`、Chrome / Firefox) |
| 2. 録画した MP4 が再生でき、長さが録画時間と ±1秒以内 | 達成(ずれは実測 -0.4〜+0.45 秒) | E2E |
| 3. 直近30秒を巻き戻して再生できる | 達成 | E2E(40秒ほどかかる) |
| 4. NVENC があれば使い、なければ libx264 | 達成(選び方) | 単体テスト(`crates/capture/src/encoder.rs`。偽の ffmpeg で両方の場合)。GPU のある環境での実物は未確認 |

最新の結果(2026-10-18、`ef7c740`): Rust 73件、web 単体 19件、E2E 127件がすべて通る。全体の連続実行でも確かめた。開発ビルドの dew は画面(web/dist)を実行時に読むので、ビルドし直したら `dew stop` してから確かめる(古いサーバには警告が出る)

## 2. フェーズ4で作ったもの

| 場所 | 中身 |
|---|---|
| `crates/capture/src/encoder.rs` | h264_nvenc で1枚エンコードしてみて、使えれば NVENC、だめなら libx264(ADR 0014)。`dew doctor` にも出す |
| `crates/capture/src/record.rs` | 録画。配っている H.264 を時刻付きの FLV にして ffmpeg の `-c copy` で MP4 へ。押した時刻に近いキーフレームから(ADR 0015)。キーフレームの間隔は1秒にした |
| `crates/server/src/live.rs` | `POST /api/live/record`、精度モードの窓の一覧と `/ws/live/{id}`(PNG) |
| `web/src/canvas/liveRewind.ts` | 一時停止・巻き戻し。ブラウザが直近30秒の H.264 を持ち、別の復号器でキーフレームから復号し直す(ADR 0016) |
| `python/dew_hooks/` | 精度モードのフック(sitecustomize が cv2 の import を捕まえて imshow・waitKey を差し替え、PNG を Unix ソケットへ)。`crates/dew/src/hooks.rs` がバイナリに同梱して `~/.cache/dew/python/` へ書き出す(ADR 0017) |
| `crates/capture/src/exact.rs` | 精度モードの受け口(窓の名前ごとに ID を 0x40000000 から振る、キーを waitKey へ返す) |
| `tests/apps/exact_sample.py` | 乱数の画像を cv2.imshow で出し、送った画素をファイルに書く |

フェーズ3の作りは `docs/decisions/` の 0009〜0013 と、各ファイルの先頭のコメントを見る。

## 3. 未解決・次にやること(上から優先)

仕様にあってまだ作っていない項目の一覧は `docs/spec.md` の 9.2(実装状況)にある。作ったら、その表から消す。

1. (済 2026-10-18)フェーズ4の終わりの報告と、ユーザーの確認を受けた修正(下部を動画と同じ並びに、録画は表示している映像を録る、ヒントの帯の出し分け、ライブへ戻るのは q、古いサーバの警告、精度モードの窓を閉じたら出し直さない、dew stop で1行だけ出して終わる)。人が確かめる手順は `docs/manual/phase4-check.md`。`phase-4` は push 済み
2. GPU のある環境での NVENC の実物の確認(人が `dew doctor` と録画・巻き戻しで確かめる)
3. 9.2 の残り: 親からはみ出した一時的な窓(ADR 0012)、ライブ映像と音声の同期、平文 HTTP のフォールバック、`dew update`、`:` のコマンドパレット、キーマップの設定ファイル、再接続時の配置の復元、「ログを見る」、LICENSE(文面は人が決める)
4. **負荷が高いときだけ落ちる E2E**: フェーズ2の「キャンバスの s で2本を同期再生する」と、フェーズ3のライブウィンドウが 20 秒以内に出ない、がまれに起きる(単独では通る)。基準3と同じく perf プロジェクトへ移すのが候補(ADR 0011)
5. 開発用コンテナを作り直すと Playwright の Firefox(`~/.cache/ms-playwright`)が消える(このセッションでも2回入れ直した)。Dockerfile に `npx playwright install firefox` を足すのはユーザーの判断(Docker のファイルはユーザーが手を入れている)
6. `tests/fixtures/komasan.png` はユーザーが置いたファイル。消さない
7. ユーザーの確認待ち: Zen で2本並べたとき、フォーカス中の右側の動画が黒くなる問題への対策が効いたか

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
- テストが読む口: `data-decoded`(ライブウィンドウの描いたフレーム数)、`data-input`(入力モード)、`data-recording`、`data-paused`・`data-rewind`(live / paused / playing)、`data-exact`、`window.dewTest.audioPeakHz()`(鳴らす設定の音だけを測る)、`data-testid="live-window"`
- E2E の dew は素材の複製(`dew.root`)の中で起動する。録画はそこの `dew-recordings/` にできる
- 一時ファイルの削除で `rm -rf $HOME` のような変数を使うと安全装置で止まる。テストの HOME は新しいディレクトリを作って使う

## 5. ユーザーについて

- 文章・コメント・コミットメッセージは日本語。UI の文言は `web/src/i18n/ja.ts` に集める
- vimmer だが、友人のために文字入力以外の全操作をマウスでもできるようにしたい。重ねて出す画面には閉じるボタンを付ける
- Zen ブラウザを使う(Firefox 系)。E2E は Chrome と Firefox の両方で回す
- 見た目は試しながら決めたい。仕様にない UI の判断は既定に近い案で進め、ADR に残して報告する
- このプロジェクトでは、ファイルの編集やコマンドの実行に事前の確認は要らない(`CLAUDE.local.md`)。ただし、仕様の矛盾、受け入れ基準を満たせないと分かったとき、新しい外部依存(apt など)は止めて聞く。push とマージは許可を得てから
