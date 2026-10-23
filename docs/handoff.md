# 引き継ぎ(2026-10-22 時点、フェーズ6の後・開発する場所をサーバへ移す前)

次のセッションが、この文書だけで続きを始められるようにまとめる。仕様は `docs/spec.md`、判断の記録は `docs/decisions/`(ADR 0001〜0027)が正。迷ったら spec → ADR の順に見る。

## 1. 今どこにいるか

- **開発用コンテナを dotfiles の新しい見本に合わせた**(2026-10-22、ブランチ `dev-container`(`phase-6` の上)、ADR 0027、spec 10章)。WSLg に依存しないので、WSL2 でも Linux サーバのコンテナでも同じ `./dev.sh` で入れる。設定は `compose/.env`(`compose/.env.example` から作る)。E2E の Firefox の音は、テスト中だけ立てるブラウザ用の pulseaudio に出す(`tests/e2e/lib/browser-audio.ts`)。新しいコンテナで Rust 114件・web 単体 33件が通り、E2E は perf を単独で流すと通る(全体で流したときはホストの負荷で perf が落ち、後の timing は流れなかった)。**続きは、開発する場所を共用の Linux サーバのコンテナへ移すこと**(4.1)
- **フェーズ6(ドキュメントウィンドウ・Markdown、spec 15・17章)を作った**(2026-10-21、ブランチ `phase-6`、ADR 0024。確認を受けた修正は ADR 0025・0026)。受け入れ基準は自動テストで確かめた。見た目・操作感の確認は `docs/manual/phase6-check.md`。続きはフェーズ7(CSV。DuckDB を zig + cargo-zigbuild で musl に組み込むところから)
- **フェーズ5(シェル連携・外部ツール連携、spec 13・14章)を作った**(2026-10-21、ブランチ `phase-5`、ADR 0023)。受け入れ基準は自動テストで確かめた(bash・zsh とも。zsh は開発用コンテナの Dockerfile に足した)。実際の端末・WezTerm での確認は `docs/manual/phase5-check.md`。続きはフェーズ6(ドキュメントウィンドウ・Markdown)
- **フェーズ1〜4(spec 9 章)はすべて終わり、受け入れ基準(spec 11 章)は全部達成**。`main` に入っている
- **v0.1.0 をリリースした**(2026-10-18)。ソースの `f15acdf`(PR #6)に `v0.1.0` のタグ
- **ソースを公開し、リポジトリを1つにした**(2026-10-19、ADR 0020)
  - 友人の意見(開発とリリースのリポジトリが分かれている違和感)を受けて、`kWat0M/DevView` を **`kWat0M/dew` に改名して Public** にし、バイナリだけの `kWat0M/dew-releases` は**削除済み**。手元の push 先も `git@kWat0M_github:kWat0M/dew.git` に変えてある
  - `dew update` の既定の取得先、LICENSE・README の配布場所は `kWat0M/dew`(PR #7)
  - **v0.1.1 を `kWat0M/dew` の Releases に出した**(2026-10-19、`6c83a91`。プレビューの修正・ソースの公開・README)。`dew update` で「dew 0.1.1 は最新です」と出ることを確かめた
  - **v0.1.2 を出した**(2026-10-19、タグ `v0.1.2` は `84d591a`。dotfiles の dev-tools イメージもこの版を入れる): git 管理外で `$HOME` の外(コンテナの `/workspace` など)で起動したら、起動したディレクトリを閲覧範囲にする。起動時と `dew status` で範囲を出す(ADR 0021)。ユーザーがサーバ上の自分のコンテナで試したら、範囲が空の `/root` になって使えなかったため
  - 0.1.0 を入れた人の `dew update` は、なくなった dew-releases を見るので更新できない。一度だけ README の「入れ方」で入れ直してもらう(CHANGELOG の「未リリース」に書いた)
- README を手直しした(PR #7): 入れ方の直後に「使う場所ごとの準備」(Docker は `docker run -p` → 毎回打たずに済む compose.yaml の書き方の順、リモートのサーバ)、`dew env` の使い方と戻し方。冒頭の4本の紹介動画は、ユーザーが GitHub の Web で MP4 を上げて README に入れた(`user-attachments` の URL。git には入れない)
- 紹介動画は `scripts/demo/record.sh` で撮り直せる(5 章)
- Home の不具合を直した(v0.1.1): 右カラムに中身を出しているディレクトリも監視し、ファイルができたらプレビューを読み直す(録画を始めてできた空の `dew-recordings/` が、MP4 ができても「空のディレクトリです」のままだった)
- 最新のテスト結果(`root-default`): Rust 82件、web 単体 19件、E2E 137件(Chrome・Firefox・perf・timing)がすべて通る

### ブランチ

| ブランチ | 状態 |
|---|---|
| `main` | 最新(`466cdcf`、PR #13 でフェーズ5まで。v0.1.2 も入っている)。直接コミットしない |
| `phase-6` | フェーズ6とその修正(ADR 0024〜0026)。push 済み。PR・マージはユーザー |
| `dev-container` | `phase-6` の上に、開発用コンテナの書き換え(ADR 0027)。push 済み。PR・マージはユーザー |
| `handoff-0.1.0` | 手元だけ(push していない)。**サーバの IP とホームのパスが入っているので push しない**。中身はこの文書に取り込んだので消してよい |
| `phase-*`・`release-1`・`public-repo`・`fix-dir-preview`・`readme-docker-*`・`backup/*` | マージ済み・古い控え。消してよい(消すのはユーザーの判断) |

- PR とマージは、ユーザーが GitHub の Web で行う(`gh` は未ログイン)。こちらは push まで。`git push` と `git merge` は `.claude/settings.json` で確認が出る。**push は毎回ユーザーの許可を得る**
- **リポジトリは公開している**。サーバの IP・ホームのパス・個人の情報をコミットに書かない。push の前に `git log main..<ブランチ> -p | grep` などで確かめる
- 作業を始めるときは `git switch main && git pull` してから、新しいブランチを切る

## 2. どこに何があるか

全体の流れは spec 6 章。主な部品:

| 場所 | 中身 |
|---|---|
| `crates/dew/` | CLI(`dew`、`dew run`・`env`・`stop`・`doctor`・`update` など)。`doctor.rs` は機能ごとに要るツールの表(ADR 0019)、`update.rs` は自己更新(ADR 0018)、`hooks.rs` は精度モードのフックの同梱、`build.rs` は版にコミットとビルド日を入れる |
| `crates/server/` | HTTPS・WebSocket(axum)。`media.rs` はファイル、`live.rs` はライブ描画(セッション、映像、音、入力、録画、精度モード) |
| `crates/media/` | ffmpeg / ffprobe の呼び出しとキャッシュ。`has_tool`・`MissingTool` でツールがないときの扱い(ADR 0019) |
| `crates/capture/` | ライブ描画: `session.rs`(Xvfb・pulseaudio。pulseaudio がなければ音なし)、`monitor.rs`(X のウィンドウの監視・配置・一時的な窓)、`stream.rs`(ffmpeg で H.264)、`encoder.rs`(NVENC か libx264)、`audio.rs`・`pulse.rs`(音とウィンドウごとの振り分け)、`input.rs`(XTest)、`record.rs`(録画)、`exact.rs`(精度モードの受け口) |
| `crates/protocol/` | 通信の型。ts-rs で `web/src/protocol/` に出力(手で書かない) |
| `web/` | React + TypeScript。`canvas/` がキャンバス(`LiveWindow.tsx`・`LiveControls.tsx`・`liveRewind.ts`・`liveAudio.ts` がライブ)、`home/` が Home、`i18n/ja.ts` に UI の文言 |
| `python/dew_hooks/` | 精度モードのフック(sitecustomize と cv2 の差し替え) |
| `tests/e2e/` | Playwright。`lib/dew.ts` の fixture(`tools` オプションで外部ツールを隠せる)。時間に厳しいものは `phase3-perf.spec.ts`・`timing-perf.spec.ts` で最後に流す(ADR 0011) |
| `tests/apps/` | テスト用の GUI アプリ(counter・popup・exact_sample など) |
| `scripts/release.sh` | 配布物を作る(`dist/`) |
| `scripts/demo/` | README の紹介動画を撮る: `record.sh`(素材を作って Playwright で録画し、`docs/demo/` に MP4 と GIF)、`make-media.sh`(ffmpeg で素材)、`apps/`(映すアプリ)。録画の操作は `tests/e2e/demo/`(設定は `tests/e2e/demo.config.ts`。ふつうの E2E には入らない) |
| `docs/manual/` | 人が行う手順: `release.md`(リリース)、`remote-test.md`(リモートサーバでの確認)、`phase3-check.md`・`phase4-check.md`(見た目・操作感の確認) |
| `README.md`・`LICENSE`・`CHANGELOG.md` | 利用者向けの説明・利用条件・変更履歴。配布物にも入れる |

## 3. 次にやること(候補。上から優先)

### 3.0 ドキュメントウィンドウの修正(2026-10-22 に済んだ。ADR 0026)

2026-10-21 のユーザーの指摘6件を `phase-6` で直した: `Esc` で抜けない(`q` / `Ctrl+]`、ヒントは `Backspace`)、ヒント中の帯、下部のバーのボタン(戻る・進む・検索・目次・文字の大きさ)、中クリックで新しいウィンドウ、マウスのサイドボタンで戻る・進む、操作パネルの Markdown の節、`e` で文字コード。**残り: サイドボタンでブラウザ自体のページが移らないことを、ユーザーに Chrome と Firefox で手で確かめてもらう**(自動テストではサイドボタンを押せない。`docs/manual/phase6-check.md` の 10)。続きはフェーズ7(CSV)

ほかの候補(ユーザーに聞いてから始める):

0. **次の版を出すとき**: 版の付け方は、出した版と同じ版で中身を変えて出すのは避ける(友人の手元と区別できなくなり、公開済みのタグの付け直しにもなるため)
1. **ユーザーの確認待ち**: Zen で2本並べたとき、フォーカス中の右側の動画が黒くなる問題への対策が効いたか
2. **NVENC の実物の確認**: 開発用コンテナには GPU が渡っていない(`/dev/dxg` も `libcuda` もない)。compose/compose.yaml に GPU の指定(`deploy.resources.reservations.devices` で `driver: nvidia`、`capabilities: [gpu, video]`)を足すかはユーザーの判断(2026-10-22 のサーバへの移動では「試さなくてよい」との回答)。WSL では GPU の指定があるとコンテナを作れないので、足すなら別の compose ファイルにする。足したら `dew doctor` で確かめる
3. **spec 9.2 の残り**(未実装・一部だけ):
   - 平文 HTTP + MSE へのフォールバック(2.3)
   - `dew status` のタブ数・ライブウィンドウ数(3.1)
   - `:` のコマンドパレット(5.3)
   - キーマップと入力モードを抜けるキーの設定ファイル `~/.config/dew/config.toml`(5.5、5.6)。できたら `dew update` の取得先もここで変えられるようにする(今は環境変数 `DEW_UPDATE_REPO`)
   - 再接続時のキャンバスの配置と再生位置の復元(7.7)
   - 一時的な窓のうち、親からはみ出した部分を映す(7.9、ADR 0012)
   - ライブ映像と音声の同期(3.3 L5)
   - 「ログを見る」(7.11)
4. **開発用コンテナの Firefox**: 作り直すと Playwright の Firefox(`~/.cache/ms-playwright`)が消える(何度も入れ直した: `cd tests/e2e && npx playwright install firefox`)。Dockerfile に足すかはユーザーの判断(Docker のファイルはユーザーが管理している)
5. マージ済みのブランチの片付け(ユーザーの判断)

### 次のリリースの手順(`docs/manual/release.md` の 3)

1. 新しいブランチで `CHANGELOG.md` に変更点を書き、`Cargo.toml` の `version` を上げ、PR で `main` に入れてもらう
2. `main` で `scripts/release.sh`(コミットしていない変更があると止まる)。配布物で E2E を流すなら `DEW_BIN=<dist の dew> pnpm -C tests/e2e exec playwright test`
3. タグ `v<版>` を付けて push(許可を得る。`dew update` はこのタグ名で版を比べる)
4. ユーザーが Web で `kWat0M/dew` の Release を作り、tar.gz を載せる
5. 前の版の配布物の dew で `dew update` を実行して、新しい版を見つけるか確かめる(0.1.0 は dew-releases を見るので使えない。最初の確認は 0.1.1 → 次の版で)

README の紹介動画を撮り直すときは `scripts/demo/record.sh`(1本だけなら `record.sh 2-compare` のように名前の一部を渡す)。素材は `$DEW_DEMO_DIR`(既定 `/tmp/dew-demo`)の `my-project` に作る(Home のパンくずに出るので短いパスにしている)。出力の `docs/demo/*.mp4` を、ユーザーが GitHub の Web の編集画面へドラッグして README の URL を差し替える(git には入れない。`docs/demo/` は git 管理外)。録画にはカーソルとキーが映らないので、`tests/e2e/demo/lib.ts` がカーソル・押したキー・字幕・端末の様子を画面に重ねている

## 4. 作業の決まりと注意

- **作業は開発用コンテナの中で行う**(`./dev.sh` で入る。HOME は `/home/dev`)。コンテナの外(WSL やサーバの本体)で Claude Code を起動すると、ffmpeg・Xvfb・Chrome がなくテストが流せない。そのときはユーザーにコンテナに入り直してもらう。コンテナの中に docker はないので、`./dev.sh build` などの作り直しはユーザーが行う
- **コミットはテストの結果を確かめてから**。テストとコミットを `;` でつながない
- 確認のコマンド:
  ```bash
  cargo fmt && cargo clippy --all-targets -q -- -D warnings
  cargo nextest run
  pnpm -C web lint && pnpm -C web test
  pnpm -C tests/e2e test          # web のビルドと cargo build も中でやる。全体で 2.5 分ほど
  ```
- protocol の型を変えたら `cargo nextest run -p dew-protocol` で `web/src/protocol/` を作り直す
- 開発ビルドの dew は、画面(`web/dist`)を実行時にディスクから読む。dew は動いているサーバを使い回すので、ビルドし直したら `dew stop` してから確かめる(古いサーバには警告が出る)。ユーザーに確認を頼むときも、手順に `dew stop` を入れる
- E2E は並列で流れるので、負荷が高いときだけ落ちるテストがまれにある。単独で流し直して確かめる(`--repeat-each` も使う)。E2E が失敗すると、`dew run` の出力とサーバのログの末尾がテストの出力に出る
- React の lint(React Compiler)は、描画中に ref を読む・state の値を書き換える・effect の中で setState する書き方を通さない。ref は effect の中で書き換え、クラスのインスタンスは `useState(() => new …)` で持ち、メソッド経由で変える
- Xvfb は抽象名前空間のソケットで待ち受けるので、つなぐ側もそこを見る(`session.rs`・`monitor.rs`。前の開発用コンテナは `/tmp/.X11-unix` を WSLg と共有していて使えなかったため。利用者の環境でも同じことがある)
- pulseaudio は `--realtime=false --high-priority=false` を付けないと D-Bus を待って起動が遅れる
- Tk などは、ウィンドウマネージャがいないと動かされた位置を知らない。dew がウィンドウを動かすときは合成の ConfigureNotify を送る(`monitor.rs` の `move_window`。ADR 0012 追記)
- テストが読む口: `data-decoded`、`data-input`、`data-recording`、`data-paused`・`data-rewind`(live / paused / playing)、`data-exact`、`window.dewTest.audioPeakHz()`(鳴らす設定の音だけを測る)、`data-testid="live-window"`・`"hint-bar"`・`"tool-missing"`
- E2E の dew は素材の複製(`dew.root`)の中で起動する。録画はそこの `dew-recordings/` にできる
- 一時ファイルの削除で `rm -rf $HOME` のような変数を使うと安全装置で止まる。テストの HOME は新しいディレクトリを作って使う
- `tests/fixtures/komasan.png` はユーザーが置いた、**著作権の都合で公開できないファイル**。消さない・公開しない(`tests/fixtures/` ごと git 管理外)

### 4.1 開発する場所(WSL とサーバ)

- 2026-10-22 から、開発する場所を共用の Linux サーバ(Docker が使える、NVIDIA の GPU あり)のコンテナへ移す。リポジトリはサーバの `~/projects/DevView` に clone し、dotfiles も clone して `compose/.env` の `DOTFILES` に書く。`SYNC_HOST` はサーバの `uname -n`、`DEW_PUBLIC_HOST` はサーバの IP(ここには書かない。ユーザーに聞く)
- 共用のサーバなので、`DEW_PORT` / `VITE_PORT` は他の人と重ならない番号にする。dev-tools のイメージ名にはユーザー名が入る(`dev-tools-<ユーザー名>`)
- Windows からサーバへは踏み台を経由して入る(経路はユーザーに聞く)。dew 本体はトークン付き URL で直結できる(確かめ済み)。Vite の開発サーバはサーバの `127.0.0.1` だけで受けるので、`ssh -J <踏み台> -L 5173:localhost:<VITE_PORT> <サーバ>` で開く
- Claude Code のメモリ(`~/.claude/projects/…/memory/`)はサーバへ持っていかない。続きに要る決めごとはこの文書・spec・ADR に書く。サーバでは `claude` に入り直し、dotfiles の `setup.sh` で `~/.claude` を用意する
- 素材(`tests/fixtures/`)は git 管理外なので、サーバでは `scripts/gen-fixtures.sh` で作る。ただし `tests/fixtures/komasan.png` は作れない(4章の最後。要るならユーザーが自分で運ぶ)
- 新しいコンテナでは Playwright の Firefox を入れ直す(`pnpm -C tests/e2e exec playwright install firefox`)

### 4.2 作業の進め方(ユーザーとの決めごと)

- ファイルを書く前・実験のコマンドを流す前に、作業の概要・理由・書く内容の差分を示して許可を得る(ユーザーの共通の CLAUDE.md。読み取り・検索は確認なしでよい)。許可は示した範囲だけに効く
- ただし、計画を示して承認を得た範囲は、差分を見せずに実装・テスト・コミットまで進めてよい。計画にない仕様の判断や範囲外の変更が出たときだけ聞く(2026-10-22 のユーザーの指示)
- **push とマージは毎回許可を得る**。PR・マージ・Release の作成はユーザーが Web で行う
- 止めて聞くのは CLAUDE.md のとおり(仕様の矛盾、受け入れ基準を満たせないと分かったとき、新しい外部依存(apt など))
- Dockerfile・compose は書いてよいが、コンテナの作り直しはユーザーが行う(zig をコンテナに入れるのも了承済み。フェーズ7の DuckDB 用、ADR 0022)
- WezTerm で確かめるときは、ふだんの `wezterm.lua` を変えずに `wezterm --config-file <テスト用>` の別ウィンドウで行う。`wezterm.exe` の場所はそのときユーザーに聞く(`C:\Program Files\WezTerm` にはない)
- rc ファイルへの `dew shell-init` の追記はユーザーが自分で行う(Dockerfile では追記しない)

## 5. ユーザーについて

- 文章・コメント・コミットメッセージ・ADR は日本語。UI の文言は `web/src/i18n/ja.ts` に集める
- vimmer だが、友人のために文字入力以外の全操作をマウスでもできるようにしたい。重ねて出す画面には閉じるボタンを付ける
- Zen ブラウザを使う(Firefox 系)。E2E は Chrome と Firefox の両方で回す
- 見た目は試しながら決めたい。仕様にない UI の判断は既定に近い案で進め、ADR に残して報告する。実際に触って細かい直しを頼んでくることが多い(例: ライブへ戻るキーを q に、録画中は枠を赤く)
- リモートのサーバ(VPN 経由)でも試す。接続先はユーザーに聞く(公開リポジトリなので、IP などはここに書かない)。証明書の警告は許可して使う方針
- 配布: 友人に配る。ソースは `kWat0M/dew` で公開(ADR 0020)。開発用コンテナは作者の環境(dotfiles)用のままでよく、README に注記もしない(ユーザーの判断)。LICENSE は「自由に使える、再配布と自作と称するのは禁止、GitHub 上の閲覧・フォークは除く、AI(Claude Code)が作成し作者は内容に責任を負わない」。Issue のテンプレートや案内は作らない(Issues は既定のまま受け付ける)
