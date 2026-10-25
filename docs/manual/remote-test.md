# リモートサーバでの確認(2つのコンテナ・ライブ描画)

実際のリモートサーバで dew を確かめる手順。確かめるのは次の2つ。

- フェーズ1の受け入れ基準「2つのコンテナで同時に起動しても、ポートとトークン(Cookie)が衝突しない」(手順5)
- フェーズ3のライブ描画(GUI アプリの表示・音・入力)が、サーバのコンテナから Windows のブラウザまで届くこと(手順6)

開発用コンテナ(WSL2)で作ったバイナリをサーバへ持っていき、サーバ上に**テスト専用のコンテナを2つ**立てて、両方で `dew` を動かす。Windows のブラウザから2つを同時に開いて、混ざらないことを確かめる。

以下の `<server>` はサーバのホスト名(Windows から届く名前か IP)、`<user>` はサーバのユーザー名に読み替える。

## 使うコンテナ

サーバにすでにあるコンテナは使わず、リポジトリの `tests/remote/` にあるテスト専用のイメージを使う。

| ファイル | 内容 |
|---|---|
| `tests/remote/Dockerfile` | `ubuntu:24.04` に dew の実行時の依存(ffmpeg、Xvfb、pulseaudio)とテスト用アプリの Python ライブラリ(pygame、tkinter、matplotlib、OpenCV)を入れ、dew 本体(`/usr/local/bin/dew`)、テスト素材(`/home/tester/fixtures`)、テスト用アプリ(`/home/tester/apps`)をコピーしたイメージ。root ではない一般ユーザー `tester` で動く(実際の運用と同じ)。`pactl`(pulseaudio-utils)は、dew が使わないことを確かめるためにわざと入れていない |
| `tests/remote/compose.yaml` | 上のイメージから2つのコンテナ(`dew-test-a` と `dew-test-b`)を立てる。ホスト側のポートは 18765 と 18766 に分け、それぞれに `DEW_PUBLIC_HOST` と `DEW_PUBLIC_PORT` を渡す |

- compose のプロジェクト名は `dew-test`、コンテナ名は `dew-test-a` / `dew-test-b`、イメージ名は `dew-test`。既存のコンテナとは名前が重ならず、片付けもこの名前だけを消せばよい
- 素材を tester のホームに置いてあるので、`dew` を引数なしで起動すれば Home に素材が出る(閲覧範囲は、git 管理外なので $HOME)
- サーバに必要なのは Docker と Docker Compose(`docker compose` コマンド)だけ。イメージを作るときに `ubuntu:24.04` と apt のパッケージをインターネットから取ってくる(Python のライブラリを含むので、イメージは 1 GB 前後になる)

## 1. バイナリと素材を作る(WSL の開発コンテナで)

```bash
cd ~/projects/DevView
scripts/gen-fixtures.sh
pnpm -C web build
cargo zigbuild --release --target x86_64-unknown-linux-musl
```

できるもの:

- `target/x86_64-unknown-linux-musl/release/dew`(単一バイナリ。サーバの OS に関係なく動く)
- `tests/fixtures/`(確認用の動画と画像)
- テスト用アプリはリポジトリの `tests/apps/` をそのまま使う(作るものはない)

## 2. サーバへ送る(WSL の開発コンテナで)

イメージを作るのに必要な5つ(Dockerfile、compose.yaml、dew、fixtures、apps)を、サーバの `~/dew-test/` にまとめて置く。前回の確認で `~/dew-test/` が残っていても、上書きすればよい(`.env` はそのまま使える)。

```bash
ssh <user>@<server> 'mkdir -p ~/dew-test'
scp tests/remote/Dockerfile tests/remote/compose.yaml target/x86_64-unknown-linux-musl/release/dew <user>@<server>:~/dew-test/
scp -r tests/fixtures tests/apps <user>@<server>:~/dew-test/
```

`tests/fixtures/` に手で置いたファイル(テスト素材以外)があれば、それも一緒に送られる。困る場合は、送ったあとにサーバ側で消す。

## 3. テスト用のコンテナを2つ立てる(サーバで)

`ssh <user>@<server>` で入ってから実行する。

### 3-1. サーバのホスト名を `.env` に書く

dew が表示する URL(`https://<ホスト名>:18765/?token=…`)のホスト名部分を、`~/dew-test/.env` に書いておく。compose はこのファイルを毎回自動で読むので、以降の `docker compose …` のたびに指定しなくてよい(書かないと `required variable DEW_PUBLIC_HOST is missing a value` で止まる)。

書く値は、**Windows のブラウザからサーバに届く名前か IP アドレス**。迷ったら IP アドレスを書く(名前は Windows から引けないことがあり、そのときブラウザは「サイトが見つからない」になる)。ふだん Windows から `ssh <user>@<server>` で入っているなら、その `<server>` の部分と同じものでよい。

- Tailscale などの VPN 経由でつないでいる場合は、Windows からその VPN で届く IP を書く(`Test-NetConnection <IP>` の `InterfaceAlias` に VPN の名前が出る)
- `~/.ssh/config` の別名(`Host` に書いた名前)で入っている場合は、その別名ではなく `HostName` に書いた値を使う(ブラウザは ssh の別名を知らないため)
- 分からないときはサーバで次を実行し、出てきた名前か IP のうち Windows から届くものを使う

  ```bash
  hostname -f   # ホスト名(社内 DNS などで引ける場合)
  hostname -I   # IP アドレス(複数出たら、Windows と同じネットワークのもの)
  ```

```bash
cd ~/dew-test
echo 'DEW_PUBLIC_HOST=<server>' > .env   # 例: DEW_PUBLIC_HOST=192.168.1.20
cat .env
```

### 3-2. Windows からポートに届くか確かめる

コンテナを立てる前に、サーバの 18765 番に Windows から届くかだけを確かめておく。届かない場合は dew の問題ではないので、先に切り分けられる。

```bash
# サーバで(コンテナの外で)。確かめ終わったら Ctrl+C で止める(Ctrl+Z だとポートを持ったまま残る)
python3 -m http.server 18765 --bind 0.0.0.0
```

```powershell
# Windows の PowerShell で
Test-NetConnection <server> -Port 18765
```

`TcpTestSucceeded : True` なら届いている。False なら、サーバのファイアウォールか大学・会社のネットワークで閉じられているので、下の「ssh -L で試す」を使う。

### 3-3. コンテナを立てる

```bash
docker compose up -d --build
docker compose ps
```

`dew-test-a`(ポート 18765)と `dew-test-b`(ポート 18766)が `running` になっていればよい。初回と、Dockerfile や dew を入れ替えたあとはイメージを作り直すので数分かかる(前回のコンテナがあれば、新しいイメージで作り直される)。

`failed to bind host port 0.0.0.0:18765/tcp: address already in use` で止まったら、そのポートをほかのプロセスが使っている。

```bash
ss -ltnp | grep -E '1876[56]'                 # 使っているプロセスと pid
ps -o pid,user,stat,cmd -p <pid>              # STAT が T なら一時停止したまま残っている
kill <pid>                                    # 一時停止中で止まらなければ kill -9 <pid>
docker compose up -d
```

ほかの人のプロセスで止められないときは、`compose.yaml` の `ports` と `DEW_PUBLIC_PORT` の番号を空いているものに変える(2か所とも同じ番号にする)。

## 4. それぞれのコンテナで dew を起動する(サーバで)

```bash
docker compose exec a dew
docker compose exec b dew
```

それぞれ `https://<server>:18765/?token=…` と `https://<server>:18766/?token=…` のように、別のポートと別のトークンの URL が出る。dew はバックグラウンドに回ってすぐ端末に戻るので、このあとのコマンドも同じ端末で続けられる。URL をもう一度見たいときは `docker compose exec a dew url`。

## 5. Windows のブラウザで確かめる

2つの URL を、同じブラウザの別のタブで開く。表示された URL を `https://` のまま開く(`http://` や `127.0.0.1` に変えない。`127.0.0.1` は Windows 自身を指す)。初回は自己署名証明書の警告が出るので許可する(ポートごとに1回。コンテナを作り直すと証明書も変わるので、また出る)。

- Zen(Firefox 系): 「詳細情報」→「危険性を承知で続行」
- Chrome / Edge: 「詳細設定」→「(安全ではありません)にアクセスする」

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | 両方のタブで「クリックかキーを押して開始」を押す | 両方とも Home が出て、`fixtures` が見える |
| 2 | タブ A を再読み込み → タブ B を再読み込み → もう一度 A | どちらもログインしたまま(Cookie が上書きされない) |
| 3 | タブ A の URL のポートだけを 18766 に変えて、新しいタブで開く | 401(B のトークンではないので開けない) |
| 4 | サーバで `docker compose exec a dew fixtures/h264_aac.mp4` | タブ A にだけ動画のウィンドウが出る。タブ B には出ない |
| 5 | サーバで `docker compose exec b dew fixtures/h264_aac.mp4` | タブ B にだけ出る |
| 6 | サーバで `docker compose exec a dew status` と `docker compose exec b dew status` | ポートとトークンがそれぞれ違う |
| 7 | 両方のタブで `fixtures/mp4v.mp4` を開いて再生 | どちらも再生できる(変換はそれぞれのコンテナで行われる) |

1〜7 がすべて期待どおりなら、基準を満たしている。

うまくいかないとき:

- 「サイトが見つからない」: URL のホスト名を Windows が引けていない。`.env` の `DEW_PUBLIC_HOST` を IP アドレスにして `docker compose up -d --force-recreate` で作り直す
- URL が開けない(タイムアウト): サーバの 18765・18766 番に Windows から届いていない。手順3-2で確かめる。サーバのファイアウォール(`sudo ufw status` など)も見る。開けられない環境では、下の「ssh -L で試す」を使う
- 「接続が拒否されました」: そのアドレスとポートで待ち受けているものがない。`127.0.0.1` で開いていないか、`docker compose ps` でコンテナが動いているかを確かめる
- `docker compose` がない: 古い Docker では `docker-compose`(ハイフン付き)の場合がある。どちらもなければ、サーバの管理者に Docker Compose を入れてもらう
- dew のログを見たい: `docker compose exec a cat /home/tester/.cache/dew/log/server.log`

## 6. ライブ描画を確かめる(サーバで、タブ A を見ながら)

手順4で起動した dew をそのまま使う。アプリは `docker compose exec -d` で裏で動かす(`dew run` はアプリが終わるまで戻らないため)。`dew run` が、仮想ディスプレイ(Xvfb)と音声(pulseaudio)をコンテナの中に自動で用意する。

| # | 操作(サーバで) | 期待する結果(タブ A) |
|---|---|---|
| 1 | `docker compose exec -d a dew run python3 apps/counter.py --seconds 300` | キャンバスに「counter」のウィンドウが出て、中央の数字が滑らかに増える。右上のミュートボタンで全体のミュートを解除すると 440 Hz の音が鳴る |
| 2 | タブ B を見る | B には何も出ない(ライブ描画もコンテナごとに分かれている) |
| 3 | `docker compose exec -d a dew run python3 apps/counter.py --tone 660 --title high --seconds 300` | ウィンドウが2つになる。クリックしたウィンドウの音(440 Hz か 660 Hz)だけが鳴る。下のバーの右端のミュートボタンで、そのウィンドウだけ消せる |
| 4 | `docker compose exec -d a dew run python3 apps/mpl_sample.py` | matplotlib のグラフが出る。タイトルバーのキーボードのボタン(または操作モードで `i`)で入力モードに入り、ツールバーの移動・拡大がマウスで使える。入力モードの表示は下のバーに出る。`Ctrl+[` かもう一度ボタンで抜ける |
| 5 | `docker compose exec -d a dew run python3 apps/counter.py --resizable --title big --seconds 300` | `w f` で最大化してから `w r` を押すと、アプリの画面が表示領域いっぱいの大きさになり、ぼやけない |
| 6 | `docker compose exec -d a dew run python3 apps/popup.py --outside` | 灰色のウィンドウの左上に赤い四角が重なって映る(右下の緑は、灰色に重なる部分だけ映る) |
| 7 | `docker compose exec -d a dew run python3 apps/cv2_sample.py` | OpenCV の窓に、大きさの変わる円が出る(60 秒で終わり、「終了」と出る) |
| 8 | `docker compose exec a dew stop`、続けて `docker compose exec a dew` | ライブ描画のアプリもまとめて終わる。新しい URL でもう一度開ける |

見るところ:

- 動きの滑らかさと遅れ(仕様の基準は LAN で遅延 150 ms 以下。Tailscale などの VPN 越しでは、回線の分だけ遅れる)
- 音が途切れないか、映像と大きくずれないか
- うまく出ないとき: `docker compose exec a dew doctor` で依存を確かめ、`docker compose exec a cat /home/tester/.cache/dew/log/server.log` のログを見る

## ssh -L で試す(ポートを開けられない場合)

Windows の端末(PowerShell など)で転送を張ってから開く。

```powershell
ssh -L 18765:localhost:18765 -L 18766:localhost:18766 <user>@<server>
```

このときは、手順3-1の `.env` を `DEW_PUBLIC_HOST=localhost` にしてコンテナを作ると、表示される URL をそのまま開ける(すでに作ったときは、`.env` を書き換えてから `docker compose up -d --force-recreate` で作り直す)。

## 7. 片付ける(サーバで)

テスト用に作ったものだけを消す。既存のコンテナやイメージには触れない。

```bash
cd ~/dew-test
docker compose down --rmi all
cd ~ && rm -rf ~/dew-test
```

`--rmi all` は、この compose のサービスが使うイメージ(`dew-test`)だけを消す。土台の `ubuntu:24.04` は残る(ほかで使っていなければ `docker image rm ubuntu:24.04` で消せる)。
