# dew

Linux(WSL2・リモートの Ubuntu サーバ・それらの中の Docker コンテナ)にある画像・動画と、プログラムが開く GUI のウィンドウを、**Windows のブラウザで見る**ためのツールです。

- 画像・動画を、音声付き・元のフレームレートで再生できます(コマ送り、A-B ループ、複数の動画の同期再生・比較、画素の値の表示)
- `cv2.imshow`・matplotlib・pygame などのウィンドウを、**プログラムを書き換えずに**ブラウザへ映せます(キー・マウスの入力も送れます)
- 映したウィンドウは、録画(MP4)・直近 30 秒の巻き戻しができます
- 1つのコマンド・1つのポートで動き、ブラウザ側に入れるものはありません

## Demo
「ファイルを開く(キーでもマウスでも)」


https://github.com/user-attachments/assets/12732c45-21d9-4287-9c14-aeb2f5297b03

  
「並べて比べる」


https://github.com/user-attachments/assets/d266629b-a2b2-4e3f-ac9e-76f96dab21d0


「GUI のウィンドウを映す」


https://github.com/user-attachments/assets/a046befa-161b-4637-9528-74e2aad027d7


「録画と巻き戻し」


https://github.com/user-attachments/assets/82736b2a-42cb-4993-b110-769ba91977d2


## 必要なもの

見る側(Windows)は、Chrome / Edge / Firefox 系(Zen など)の最新版があれば十分です。

dew を動かす Linux(x86_64)では、**何も入れなくても、ファイルの閲覧と、ブラウザが再生できる形式(MP4・WebM・PNG・JPEG など)の再生はできます**。ほかの機能は、次のツールを入れると使えるようになります。足りないときは、その機能を使おうとした場所で、何が足りないかと入れ方が出ます。

| 機能 | 要るツール |
|---|---|
| ファイルの閲覧・再生(MP4・WebM・PNG・JPEG など) | なし |
| 動画の情報(長さ・解像度)・フレーム番号・コマ送り | `ffprobe`(ffmpeg に入っています) |
| サムネイル・シークバーのプレビュー | `ffmpeg` |
| ブラウザで再生できない形式(mp4v・AVI・TIFF・16bit など)の変換 | `ffmpeg` |
| GUI のウィンドウを映す(`dew run`) | `xvfb`・`ffmpeg` |
| 映したアプリの音 | `pulseaudio`(なくても映像は映ります) |
| 録画 | `ffmpeg` |

Ubuntu / Debian なら、全部を次で入れられます(`dew doctor` で、使える機能と足りないものが分かります)。

```bash
sudo apt-get install -y ffmpeg xvfb pulseaudio
```

dew 本体は 1 つのファイル(静的リンクのバイナリ)で、Linux のディストリビューションや版を問いません。

## 入れ方

https://github.com/kWat0M/dew/releases から、最新の `dew-<版>-<コミット>-x86_64-linux.tar.gz` を取って展開し、中の `dew` をパスの通った場所に置いて実行できるようにします。ブラウザのない環境(コンテナやサーバ)では、端末で次のように取れます。

```bash
curl -fsSLO "$(curl -fsSL https://api.github.com/repos/kWat0M/dew/releases/latest | grep -o 'https://[^"]*x86_64-linux\.tar\.gz')"
```

取ったら、展開して置きます。

```bash
tar xzf dew-*-x86_64-linux.tar.gz
cd dew-*-x86_64-linux
sha256sum -c SHA256SUMS      # dew: OK(壊れていないか)
mkdir -p ~/.local/bin
cp dew ~/.local/bin/
chmod +x ~/.local/bin/dew
dew --version        # 例: dew 0.1.2 (1a2b3c4, 2026-10-19)
dew doctor           # 使える機能と、足りないツールを確かめる
```

2 回目からは `dew update` で新しい版に入れ替えられます。

`~/.local/bin` にパスが通っていない場合は、`~/.bashrc` に `export PATH="$HOME/.local/bin:$PATH"` を足してください。

## 使う場所ごとの準備

**「はじめて使う」の前に**、dew を動かす場所に合わせて次を済ませてください。

| dew を動かす場所 | 準備 |
|---|---|
| WSL2 の中(Docker を使わない) | 不要。そのまま「はじめて使う」へ |
| Docker コンテナの中 | 下の「Docker コンテナの中で使う」(ポートの公開が要ります) |
| リモートのサーバ | 下の「リモートのサーバで使う」 |

### Docker コンテナの中で使う

コンテナの中の dew は 8765 番で待ち受けるので、**コンテナを作るときに、そのポートを公開しておきます**。あとからは足せません。

**試しに使う(docker run)**: 例えば、Ubuntu のコンテナを作って入るなら次のとおりです。そのままコピーして使えます。

```bash
docker run -it -p 18765:8765 -e DEW_PUBLIC_HOST=localhost -e DEW_PUBLIC_PORT=18765 ubuntu:24.04 bash
```

- `-p 18765:8765`: ホストの 18765 番を、コンテナの dew(8765 番)につなぐ
- `-e DEW_PUBLIC_HOST`・`-e DEW_PUBLIC_PORT`: 端末に出す URL を、外(Windows)から開ける形にする。`DEW_PUBLIC_HOST` は、**Windows のブラウザから、Docker が動いているマシンを指す名前か IP アドレス**です(下の「DEW_PUBLIC_HOST の調べ方」)
- `ubuntu:24.04` はイメージ名、最後の `bash` はコンテナの中で動かすコマンドです。いつも使っているイメージがあれば、その名前に置き換えます(下の「イメージ名の調べ方」)。`alpine` などの小さいイメージには bash がないことがあり、そのときは `sh` にします

**DEW_PUBLIC_HOST の調べ方**

| Docker が動いている場所 | 入れる値 |
|---|---|
| 自分の PC の WSL2(Docker Desktop を含む) | `localhost` のまま |
| リモートのサーバ | そのサーバに ssh でつなぐときの宛先(`ssh user@xxx` の `xxx`) |

リモートのサーバの IP アドレスは、サーバの上で次のように調べられます。迷ったら、名前より IP アドレスのほうが確実です(Windows が名前を引けないことがあるため)。

```bash
hostname -I        # サーバの IP アドレスの一覧(1つ目が LAN の IP であることが多い)
tailscale ip -4    # Tailscale などの VPN 経由でつないでいるなら、その IP
```

Windows から届くかは、PowerShell の `ping <名前か IP>` で確かめられます。dew を起動したあとなら、`Test-NetConnection <名前か IP> -Port 18765` が `True` になれば届いています。

**イメージ名の調べ方**

```bash
docker images      # 手元にあるイメージの一覧。REPOSITORY と TAG を「:」でつないだもの(例: python:3.12)がイメージ名
docker ps -a       # コンテナの一覧。IMAGE の列が、そのコンテナが使っているイメージ名
docker compose images   # compose を使っているなら、そのサービスのイメージ名
```

compose で起動しているコンテナなら、`docker run` ではなく、下の「毎回打たずに済ませるには」の compose.yaml の書き方を使ってください。

コンテナに入ったら、dew を入れます(Ubuntu / Debian のイメージの場合。root で入っているので `sudo` は要りません)。

```bash
apt-get update && apt-get install -y curl ca-certificates
curl -fsSLO "$(curl -fsSL https://api.github.com/repos/kWat0M/dew/releases/latest | grep -o 'https://[^"]*x86_64-linux\.tar\.gz')"
tar xzf dew-*-x86_64-linux.tar.gz
cp dew-*-x86_64-linux/dew /usr/local/bin/
```

これだけで、ファイルの閲覧と、ブラウザで再生できる形式(MP4・PNG など)の再生ができます。GUI のウィンドウを映す・音を出す・動画を変換するなどを使うなら、ほかのツールも入れます(要らなければ入れなくてかまいません。どの機能に何が要るかは「必要なもの」の表と `dew doctor` で分かります)。

```bash
DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg xvfb pulseaudio
```

見たいファイルのあるディレクトリに移ってから起動し、端末に出た `https://<DEW_PUBLIC_HOST の値>:18765/?token=…` を Windows のブラウザで開きます(見られる範囲は「はじめて使う」の表のとおり。`$HOME` の外なら、起動したディレクトリの中です)。

```bash
cd /workspace        # 例: 見たいファイルのあるディレクトリ
dew
```

ツールをイメージに入れておくなら、Dockerfile に次を足します。

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg xvfb pulseaudio \
 && rm -rf /var/lib/apt/lists/*
```

**毎回打たずに済ませるには、compose.yaml に書きます**。`docker run` の `-p`・`-e` はコンテナを作るたびに指定が要りますが、compose.yaml の使っているサービスに次を足しておけば、以降は `docker compose up -d` だけでポートが公開され、環境変数も渡されます。

```yaml
services:
  app:                                   # 使っているサービスの名前
    ports:
      - "18765:8765"                     # ホストの 18765 番 → コンテナの dew(8765 番)
    environment:
      DEW_PUBLIC_HOST: localhost         # Windows から開くときのホスト名。リモートのサーバならその名前か IP
      DEW_PUBLIC_PORT: "18765"           # 上の ports の左側と同じ番号
```

ポートの公開はコンテナを作るときにしか変えられないので、すでに動いているコンテナには、`docker compose up -d` で作り直すまで効きません。

- 複数のコンテナで使うときは、ホスト側のポート(18765 など)をコンテナごとに変えてください。トークンが違うので、ほかの人のコンテナは開けません
- コンテナを作り直すと、コンテナの中に入れた dew と証明書(`~/.local/share/dew/tls`)は消えます。dew は入れ直し、証明書の警告はもう一度許可してください

### リモートのサーバで使う

サーバの名前を Windows から引けないことが多いので、`~/.bashrc` に `export DEW_PUBLIC_HOST=<サーバの名前か IP>` を足しておくと確実です(端末に出る URL がその形になります)。

サーバで `dew` を起動し、出た URL を開きます。開けないときは次を確かめてください。

- URL のホスト名を Windows から引けるか。迷ったら `DEW_PUBLIC_HOST` に IP アドレスを入れる
- ポートに届くか。Windows の PowerShell で `Test-NetConnection <サーバ> -Port 8765` が `True` になるか
- 届かない(ファイアウォールで閉じている)場合は、ssh のポート転送を使います

```powershell
# Windows の PowerShell で
ssh -L 8765:localhost:8765 <ユーザー>@<サーバ>
```

このときはサーバで `dew --bind 127.0.0.1` で起動し、`https://localhost:8765/?token=…` を開きます。

## はじめて使う

```bash
cd ~/my-project
dew
```

端末に `https://…:8765/?token=…` の URL が出るので、Windows のブラウザで開きます(WezTerm などではクリックで開けます)。

1. 初回は「この接続ではプライバシーが保護されません」などの**証明書の警告**が出ます。dew が自分で作った証明書のためで、通信は暗号化されています。許可して進んでください(ポートごとに1回)
   - Chrome / Edge: 「詳細設定」→「(安全ではありません)にアクセスする」
   - Firefox / Zen: 「詳細情報」→「危険性を承知で続行」
2. 「クリックかキーを押して開始」を押すと、ファイルの一覧(Home)が出ます
3. `?` でキーの一覧、右上の「操作パネル」から全部の操作をマウスでも行えます

dew は裏で動き続けるので、端末はすぐ使えます。端末を閉じても止まりません。

| コマンド | 動作 |
|---|---|
| `dew` | 起動する(動いていれば使い回す)。URL を出す |
| `dew <ファイル>` | そのファイルを開いているブラウザに表示する |
| `dew url` / `dew status` | URL と状態をもう一度出す |
| `dew stop` | 止める |
| `dew rotate-token` | URL のトークンを作り直す(開いているタブは切れる) |
| `dew doctor` | 必要なものがそろっているか確かめる |
| `dew update` | 新しい版があれば取得して入れ替える(上の Releases から) |

見られる範囲(閲覧範囲)は、起動したときに端末に出ます。次のように決まります。

| `dew` を起動した場所 | 見られる範囲 |
|---|---|
| git リポジトリの中 | そのリポジトリ全体 |
| git 管理外で、`$HOME` の中 | `$HOME` |
| git 管理外で、`$HOME` の外(コンテナの `/workspace` など) | 起動したディレクトリ |

変えるには、`dew stop` してから `dew --root <ディレクトリ>` で起動し直します(`dew --root /` でコンテナ全体)。

トークンは `~/.local/share/dew/` に保存するので、`dew stop` して起動し直しても URL は変わりません。開いたままのタブは、サーバが止まっている間「サーバ停止中」と出し、起動し直すと自動でつながり直します。ブラウザのタブを固定(ピン留め)して置いておくと便利です。

### キャンバスの操作

開いたファイルは、キャンバスにウィンドウとして並びます。キーの使い方は vim のノーマル / インサートに似ています。

- **ノーマルモード**: `h` `j` `k` `l` でウィンドウを選びます。`Tab` で Home に戻ります
- **操作モード**: `i` か `Enter`(またはウィンドウをクリック)で、選んだウィンドウの中を操作します。動画なら `k` で再生、`j` / `l` で 5 秒戻る・進む。文書なら `j` / `k` でスクロール。`Esc`・`q`・`Ctrl+[` でノーマルモードに戻ります。ファイルは開いた直後から操作モードです
- **まとめて操作**: ノーマルモードの `Space` で複数のウィンドウを選んでから `i` を押すと、選んだ同じ種類のウィンドウ(動画どうし、CSV どうしなど)に同じキーが効きます。2つのファイルを並べて同時にスクロールして見比べられます

枠の色で今のモードが分かります(青: フォーカス、緑: 操作モード、紫: アプリへの入力モード)。文字を打つ欄は、`Esc` か `Ctrl+[` で欄から抜けられます。

### ブラウザのタブがないとき

タブがないときに `dew <ファイル>` を実行すると、端末に「ブラウザのタブがありません」とそのファイルを開く URL が出ます。2分以内にどこかで dew のタブを開けば、そのファイルが開きます。

- **WezTerm**: `dew setup-wezterm` が出す設定を `wezterm.lua` に足すと、タブがないときに Windows のブラウザが自動で開きます(任意。`dew url --open` でも開けます)。tmux の中では `~/.tmux.conf` に `set -g allow-passthrough on` が要ります
- **yazi**: yazi から dew で開く設定の例は `dew doctor --help` にあります
- `~/.config/dew/config.toml` に `open_fallback_clipboard = true` と書くと、URL を端末のクリップボードにもコピーします(OSC 52 に対応した端末で)

## Markdown を読む

Home で `.md` を選んで Enter(または `dew README.md`)すると、キャンバスに読みやすく描いて出します。表・タスクリスト・数式・色分けしたコードに対応し、ファイルを書き換えるとその場で描き直します。

開いた直後からキーで読めます: `j` / `k` でスクロール、`f` でリンクを選んで開く、`H` / `L` で戻る・進む、`/` で検索、`o` で目次、`+` / `-` で文字の大きさ。`q`・`Esc`・`Ctrl+[` でキャンバスの操作に戻り、`i` でまた入ります。Shift_JIS の文書も文字化けせずに読めます(下部で文字コードを切り替えられます)。

安全のため、Markdown の中の生の HTML は描画せず、外部の画像はクリックするまで読み込みません。

## CSV を読む

Home で `.csv` / `.tsv` を選んで Enter(または `dew data.csv`)すると、キャンバスに表で出します。Excel が出力した Shift_JIS の CSV も文字化けせずに読めます。20 MB 未満・20万行未満はブラウザで、それより大きいものはサーバ(DuckDB)で並べ替え・絞り込みをするので、100万行でもすぐに結果が出ます(大きなファイルは、最初に開いたときだけ読み込みに少し時間がかかります)。

開いた直後からキーで操作できます: `hjkl` でセルを移動、`s` で並べ替え、`f` で列のフィルター、`/` で検索、`Enter` でセルの全文、`y` で値をコピー。フィルターなどの小さな画面も、`hjkl` で欄を選んで `Enter` で入れるので、キーだけで操作できます。列の表示名・小数の桁数・隠す・固定・行のマークなど、表示だけを変える機能もあり、タブを読み直しても設定が残ります(`dew stop` で消えます)。マウスでは、列の見出しのメニューと操作パネルから同じことができます。

## GUI のウィンドウを映す

```bash
dew run python3 main.py
```

`main.py` が開いたウィンドウが、ブラウザのキャンバスに出ます。プログラムは変えなくてかまいません。dew が仮想ディスプレイと音声を用意して、そちらに出させるので、WSLg や X サーバ、画面のないサーバやコンテナでもそのまま映ります。

### シェルごと映す(dew activate)

毎回 `dew run` を付けるのが面倒なら、シェルを dew に向けます。最初に1回だけ、シェル連携を入れます(bash と zsh)。

```bash
dew setup-shell      # ~/.bashrc か ~/.zshrc に1行足す(確認が出ます)。足したら端末を開き直す
```

```bash
dew activate         # プロンプトの先頭に (dew) が付く
python3 main.py      # dew run を付けなくても、ブラウザに映る
dew deactivate       # 元に戻す(DISPLAY などが activate の前の値に戻る)
```

activate 中のシェルがある間は、dew は自動で止まりません。starship を使っているときは、プロンプトの代わりに starship の設定で表示できます(`dew shell-init --help`)。

### シェルごと映す(dew env)

シェル連携を入れずに済ませたいときは、`dew env` を使います。

```bash
eval "$(dew env)"
python3 main.py      # dew run を付けなくても、ブラウザに映る
python3 other.py     # 以降、このシェルから起動したアプリはすべてブラウザに出る
```

`dew env` は、`DISPLAY`・`PULSE_SERVER` などを dew の仮想ディスプレイと音声に向ける設定を出します(`eval` で今のシェルに取り込みます)。ほかの端末には影響しません。

元に戻すには、その端末(シェル)を閉じて開き直します。端末を閉じたくなければ、先に `bash` で子のシェルに入ってから `eval "$(dew env)"` し、終わったら `exit` すると元のシェルに戻ります。

```bash
bash                 # 子のシェルに入る
eval "$(dew env)"
python3 main.py      # ブラウザに映る
exit                 # 元のシェル(dew env の前の設定)に戻る
```

### 映したウィンドウの操作

- アプリにキーやマウスを送るには、操作モードでもう一度 `i`(またはタイトルバーのキーボードのボタン)で **入力モード** に入ります。`Ctrl+[` で抜けます(`Esc` はアプリに届きます)。複数のウィンドウを選んで入ると、同じキーが全部のアプリに届きます
- `R`(またはタイトルバーの録画ボタン)で録画。表示している映像が、最初に `dew` を起動したディレクトリの `dew-recordings/` に MP4 で保存されます
- 操作モードの `k`(または下部の中央のボタン)で一時停止すると、直近 30 秒を巻き戻して見られます。`G` でライブに戻ります
- `dew run --exact python3 main.py` で **精度モード**: `cv2.imshow` に渡した画像を、圧縮せず画素どおりに表示します
- 閉じるボタンは、デスクトップの × と同じくアプリに閉じるよう頼みます(止めるかはアプリが決めます)

## 困ったとき

| 症状 | 確かめること |
|---|---|
| ブラウザで「サイトが見つからない」 | URL のホスト名を Windows が引けていない。`DEW_PUBLIC_HOST` を IP にする |
| 「接続が拒否されました」・タイムアウト | ポートに届いていない。「リモートのサーバで使う」・「Docker コンテナの中で使う」を見る |
| GUI のウィンドウが出ない | `dew doctor` で `Xvfb` と `pulseaudio` があるか |
| dew を入れ替えたのに動きが変わらない | 前の dew のサーバが動いたまま。`dew stop` してから起動し直す |
| そのほか | ログ: `~/.cache/dew/log/server.log` |

キャッシュ(サムネイルや変換した動画)は `~/.cache/dew/` にあります。消してもかまいません。

## 利用条件

自由に使ってかまいません(自分で使うための改変も可)。**再配布**(改変の有無を問わず、ほかの人へ渡す・公開する)と、**自分が作ったと称すること**は禁止です。

このソフトウェアのコードは、AI(Anthropic 社の Claude Code)がすべて作成したもので、作者は内容について責任を負いません。保証もありません。自分の判断で使ってください。詳しくは同梱の `LICENSE` を見てください。欲しい人がいたら、上の Releases のページを伝えてください。

## アンインストール

```bash
dew stop
rm ~/.local/bin/dew
rm -rf ~/.cache/dew ~/.local/share/dew
```
