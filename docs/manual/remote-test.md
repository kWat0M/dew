# リモートサーバで2つのコンテナから使う確認

フェーズ1の受け入れ基準「2つのコンテナで同時に起動しても、ポートとトークン(Cookie)が衝突しない」を、実際のリモートサーバで確かめる手順。開発用コンテナ(WSL2)で作ったバイナリをサーバへ持っていき、サーバ上に**テスト専用のコンテナを2つ**立てて、両方で `dew` を動かす。Windows のブラウザから2つを同時に開いて、混ざらないことを確かめる。

以下の `<server>` はサーバのホスト名(Windows から届く名前か IP)、`<user>` はサーバのユーザー名に読み替える。

## 使うコンテナ

サーバにすでにあるコンテナは使わず、リポジトリの `tests/remote/` にあるテスト専用のイメージを使う。

| ファイル | 内容 |
|---|---|
| `tests/remote/Dockerfile` | `ubuntu:24.04` に ffmpeg を入れ、dew 本体(`/usr/local/bin/dew`)とテスト素材(`/home/tester/fixtures`)をコピーしたイメージ。root ではない一般ユーザー `tester` で動く(実際の運用と同じ) |
| `tests/remote/compose.yaml` | 上のイメージから2つのコンテナ(`dew-test-a` と `dew-test-b`)を立てる。ホスト側のポートは 18765 と 18766 に分け、それぞれに `DEW_PUBLIC_HOST` と `DEW_PUBLIC_PORT` を渡す |

- compose のプロジェクト名は `dew-test`、コンテナ名は `dew-test-a` / `dew-test-b`、イメージ名は `dew-test`。既存のコンテナとは名前が重ならず、片付けもこの名前だけを消せばよい
- 素材を tester のホームに置いてあるので、`dew` を引数なしで起動すれば Home に素材が出る(閲覧範囲は、git 管理外なので $HOME)
- サーバに必要なのは Docker と Docker Compose(`docker compose` コマンド)だけ。イメージを作るときに `ubuntu:24.04` と ffmpeg をインターネットから取ってくる

## 1. バイナリと素材を作る(WSL の開発コンテナで)

```bash
cd ~/projects/DevView
scripts/gen-fixtures.sh
pnpm -C web build
cargo build --release --target x86_64-unknown-linux-musl
```

できるもの:

- `target/x86_64-unknown-linux-musl/release/dew`(単一バイナリ。サーバの OS に関係なく動く)
- `tests/fixtures/`(確認用の動画と画像)

## 2. サーバへ送る(WSL の開発コンテナで)

イメージを作るのに必要な4つ(Dockerfile、compose.yaml、dew、fixtures)を、サーバの `~/dew-test/` にまとめて置く。

```bash
ssh <user>@<server> 'mkdir -p ~/dew-test'
scp tests/remote/Dockerfile tests/remote/compose.yaml target/x86_64-unknown-linux-musl/release/dew <user>@<server>:~/dew-test/
scp -r tests/fixtures <user>@<server>:~/dew-test/
```

`tests/fixtures/` に手で置いたファイル(テスト素材以外)があれば、それも一緒に送られる。困る場合は、送ったあとにサーバ側で消す。

## 3. テスト用のコンテナを2つ立てる(サーバで)

`ssh <user>@<server>` で入ってから実行する。

### 3-1. サーバのホスト名を `.env` に書く

dew が表示する URL(`https://<ホスト名>:18765/?token=…`)のホスト名部分を、`~/dew-test/.env` に書いておく。compose はこのファイルを毎回自動で読むので、以降の `docker compose …` のたびに指定しなくてよい(書かないと `required variable DEW_PUBLIC_HOST is missing a value` で止まる)。

書く値は、**Windows のブラウザからサーバに届く名前か IP アドレス**。ふだん Windows から `ssh <user>@<server>` で入っているなら、その `<server>` の部分と同じものでよい。

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

### 3-2. コンテナを立てる

```bash
docker compose up -d --build
docker compose ps
```

`dew-test-a`(ポート 18765)と `dew-test-b`(ポート 18766)が `running` になっていればよい。初回はイメージを作るので数分かかる。

## 4. それぞれのコンテナで dew を起動する(サーバで)

```bash
docker compose exec a dew
docker compose exec b dew
```

それぞれ `https://<server>:18765/?token=…` と `https://<server>:18766/?token=…` のように、別のポートと別のトークンの URL が出る。dew はバックグラウンドに回ってすぐ端末に戻るので、このあとのコマンドも同じ端末で続けられる。URL をもう一度見たいときは `docker compose exec a dew url`。

## 5. Windows のブラウザで確かめる

2つの URL を、同じブラウザの別のタブで開く。初回は自己署名証明書の警告が出るので許可する(ポートごとに1回)。

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

- URL が開けない(タイムアウト): サーバの 18765・18766 番に Windows から届いていない。サーバのファイアウォール(`sudo ufw status` など)を確かめる。開けられない環境では、次の「ssh -L で試す」を使う
- `docker compose` がない: 古い Docker では `docker-compose`(ハイフン付き)の場合がある。どちらもなければ、サーバの管理者に Docker Compose を入れてもらう
- dew のログを見たい: `docker compose exec a cat /home/tester/.cache/dew/log/server.log`

## ssh -L で試す(ポートを開けられない場合)

Windows の端末(PowerShell など)で転送を張ってから開く。

```powershell
ssh -L 18765:localhost:18765 -L 18766:localhost:18766 <user>@<server>
```

このときは、手順3-1の `.env` を `DEW_PUBLIC_HOST=localhost` にしてコンテナを作ると、表示される URL をそのまま開ける(すでに作ったときは、`.env` を書き換えてから `docker compose up -d --force-recreate` で作り直す)。

## 6. 片付ける(サーバで)

テスト用に作ったものだけを消す。既存のコンテナやイメージには触れない。

```bash
cd ~/dew-test
docker compose down --rmi all
cd ~ && rm -rf ~/dew-test
```

`--rmi all` は、この compose のサービスが使うイメージ(`dew-test`)だけを消す。土台の `ubuntu:24.04` は残る(ほかで使っていなければ `docker image rm ubuntu:24.04` で消せる)。
