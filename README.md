# dew

Linux(WSL2・リモートの Ubuntu サーバ・それらの中の Docker コンテナ)にある画像・動画と、プログラムが開く GUI のウィンドウを、**Windows のブラウザで見る**ためのツールです。

- 画像・動画を、音声付き・元のフレームレートで再生できます(コマ送り、A-B ループ、複数の動画の同期再生・比較、画素の値の表示)
- `cv2.imshow`・matplotlib・pygame などのウィンドウを、**プログラムを書き換えずに**ブラウザへ映せます(キー・マウスの入力も送れます)
- 映したウィンドウは、録画(MP4)・直近 30 秒の巻き戻しができます
- 1つのコマンド・1つのポートで動き、ブラウザ側に入れるものはありません

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

https://github.com/kWat0M/dew-releases/releases から、最新の `dew-<版>-<コミット>-x86_64-linux.tar.gz` を取って展開し、中の `dew` をパスの通った場所に置いて実行できるようにします。

```bash
tar xzf dew-*-x86_64-linux.tar.gz
cd dew-*-x86_64-linux
sha256sum -c SHA256SUMS      # dew: OK(壊れていないか)
mkdir -p ~/.local/bin
cp dew ~/.local/bin/
chmod +x ~/.local/bin/dew
dew --version        # 例: dew 0.1.0 (05f218c, 2026-10-18)
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

コンテナの中の dew は 8765 番で待ち受けます。これをホストのポートとして公開し、端末に出す URL を外(Windows)から開ける形にするための環境変数を渡します。

**compose.yaml を使う場合**(おすすめ)は、使っているサービスに次を足します。一度書けば、以降は `docker compose up -d` で起動するたびに有効になり、`docker run -p …` を毎回打つ必要はありません。

```yaml
services:
  app:                                   # 使っているサービスの名前
    ports:
      - "18765:8765"                     # ホストの 18765 番 → コンテナの dew(8765 番)
    environment:
      DEW_PUBLIC_HOST: localhost         # Windows から開くときのホスト名。リモートのサーバならその名前か IP
      DEW_PUBLIC_PORT: "18765"           # 上の ports の左側と同じ番号
    volumes:
      # ホストに入れた dew をコンテナから使う(イメージに入れなくてよい。dew update はホストで行う)
      - ~/.local/bin/dew:/usr/local/bin/dew:ro
```

足したら、コンテナを作り直して(`docker compose up -d`)中に入り、そのまま `dew` を実行します。ポートの公開はコンテナを作るときにしか変えられないので、すでに動いているコンテナには `docker compose up -d` で作り直すまで効きません。

GUI のウィンドウを映す・音を出す・動画を変換するには、コンテナの中にも `ffmpeg` などが要ります。Dockerfile に次を足します。

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg xvfb pulseaudio \
 && rm -rf /var/lib/apt/lists/*
```

**compose.yaml を使わない場合**は、`docker run` に同じものを渡します。

```bash
docker run -p 18765:8765 -e DEW_PUBLIC_HOST=localhost -e DEW_PUBLIC_PORT=18765 \
  -v ~/.local/bin/dew:/usr/local/bin/dew:ro …
```

- 複数のコンテナで使うときは、ホスト側のポート(18765 など)をコンテナごとに変えてください。トークンが違うので、ほかの人のコンテナは開けません
- WSL2 の中の Docker なら、`DEW_PUBLIC_HOST` は `localhost` のままで Windows から開けます
- dew の証明書はコンテナの中(`~/.local/share/dew/tls`)に作るので、コンテナを作り直すと証明書の警告がもう一度出ます。許可すればそのまま使えます

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
| `dew doctor` | 必要なものがそろっているか確かめる |
| `dew update` | 新しい版があれば取得して入れ替える(上の Releases から) |

見られるのは、起動したディレクトリを含む git リポジトリの中(git 管理外なら `$HOME`)だけです。変えるには、`dew stop` してから `dew --root <ディレクトリ>` で起動し直します。

## GUI のウィンドウを映す

```bash
dew run python3 main.py
```

`main.py` が開いたウィンドウが、ブラウザのキャンバスに出ます。プログラムは変えなくてかまいません(dew が仮想ディスプレイと音声を用意して、そちらに出させます)。

- 以降のコマンドを全部映したいときは `eval "$(dew env)"`。そのシェルから起動したアプリはすべてブラウザに出ます
- アプリにキーやマウスを送るには、ウィンドウを選んで `i`(またはタイトルバーのキーボードのボタン)。`Ctrl+]` で抜けます
- `R`(またはタイトルバーの録画ボタン)で録画。表示している映像が、最初に `dew` を起動したディレクトリの `dew-recordings/` に MP4 で保存されます
- `k`(または下部の中央のボタン)で一時停止すると、直近 30 秒を巻き戻して見られます。`q` でライブに戻ります
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
