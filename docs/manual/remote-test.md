# リモートサーバで2つのコンテナから使う確認(受け入れ基準: フェーズ1「2つのコンテナで同時に起動しても、ポートとトークン(Cookie)が衝突しない」)

開発用コンテナ(WSL2)で作ったバイナリをサーバへ持っていき、サーバ上に確認用のコンテナを2つ立てて、両方で `dew` を動かす。Windows のブラウザから2つを同時に開いて、混ざらないことを確かめる。

以下の `<server>` はサーバのホスト名(Windows から届く名前か IP)、`<user>` はサーバのユーザー名に読み替える。

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

```bash
ssh <user>@<server> 'mkdir -p ~/dew-test'
scp target/x86_64-unknown-linux-musl/release/dew <user>@<server>:~/dew-test/
scp -r tests/fixtures <user>@<server>:~/dew-test/
```

## 3. 確認用のコンテナを2つ立てる(サーバで)

`ssh <user>@<server>` で入ってから実行する。ポートはホスト側を 18765 と 18766 に分ける(ふだんの運用で各自が別のポートを割り当てるのと同じ)。

```bash
cd ~/dew-test
for name in a b; do
  port=$([ "$name" = a ] && echo 18765 || echo 18766)
  docker run -d --name dew-$name \
    -p $port:8765 \
    -e DEW_PUBLIC_HOST=<server> -e DEW_PUBLIC_PORT=$port \
    -v ~/dew-test:/opt/dew:ro \
    ubuntu:24.04 sleep infinity
  # dew が使う ffmpeg を入れる(数分かかる)
  docker exec dew-$name bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null'
done
docker ps --filter name=dew-
```

## 4. それぞれのコンテナで dew を起動する(サーバで)

端末を2つ開き、それぞれで実行する。`/opt/dew` は git 管理外なので、閲覧範囲は `--root` で指定する。

```bash
# 端末1
docker exec -it dew-a bash
/opt/dew/dew --root /opt/dew

# 端末2
docker exec -it dew-b bash
/opt/dew/dew --root /opt/dew
```

それぞれ `https://<server>:18765/?token=…` と `https://<server>:18766/?token=…` のように、別のポートと別のトークンの URL が出る。

## 5. Windows のブラウザで確かめる

2つの URL を、同じブラウザの別のタブで開く(初回は自己署名証明書の警告を許可する。ポートごとに1回)。

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | 両方のタブで「クリックかキーを押して開始」を押す | 両方とも Home が出て、`fixtures` などが見える |
| 2 | タブ A を再読み込み → タブ B を再読み込み → もう一度 A | どちらもログインしたまま(Cookie が上書きされない) |
| 3 | タブ A の URL のポートだけを 18766 に変えて、新しいタブで開く | 401(B のトークンではないので開けない) |
| 4 | 端末1(コンテナ A)で `/opt/dew/dew /opt/dew/fixtures/h264_aac.mp4` | タブ A にだけ動画のウィンドウが出る。タブ B には出ない |
| 5 | 端末2(コンテナ B)で同じことをする | タブ B にだけ出る |
| 6 | 両方の端末で `/opt/dew/dew status` | ポートとトークンがそれぞれ違う |
| 7 | 両方のタブで `fixtures/mp4v.mp4` を開いて再生 | どちらも再生できる(変換はそれぞれのコンテナで行われる) |

1〜7 がすべて期待どおりなら、基準を満たしている。

うまくいかないとき:

- URL が開けない(タイムアウト): サーバの 18765・18766 番に Windows から届いていない。サーバのファイアウォール(`sudo ufw status` など)を確かめる。開けられない環境では、次の「ssh -L で試す」を使う
- 証明書の警告: Zen(Firefox 系)は「詳細情報」→「危険性を承知で続行」、Chrome / Edge は「詳細設定」→「(安全ではありません)にアクセスする」で進める
- `dew` は起動するとバックグラウンドに回ってすぐ端末に戻るので、手順5の4・6は同じ端末でそのまま実行できる

## ssh -L で試す(ポートを開けられない場合)

Windows の端末(PowerShell など)で転送を張ってから、URL のホストを `localhost` にして開く。

```powershell
ssh -L 18765:localhost:18765 -L 18766:localhost:18766 <user>@<server>
```

このときは、手順3の `DEW_PUBLIC_HOST` を `localhost` にしてコンテナを作ると、表示される URL をそのまま開ける。

## 6. 片付ける(サーバで)

```bash
docker rm -f dew-a dew-b
rm -rf ~/dew-test
```
