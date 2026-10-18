# リリースの手順

友人に渡す版を作って、GitHub の Releases に載せるまでの手順。

## 1. 配布物を作る(WSL の開発用コンテナで)

`main` の、リリースしたいコミットで行う。コミットしていない変更があると止まる(どの版か分からなくなるため)。

```bash
cd ~/projects/DevView
git switch main && git pull
scripts/release.sh
```

`dist/dew-<版>-<コミット>-x86_64-linux.tar.gz` ができる。中身は `dew`(静的リンクの単一バイナリ)、`README.md`、`LICENSE`、`CHANGELOG.md`、`SHA256SUMS`。

配布物そのもので E2E を流すときは:

```bash
DEW_BIN=$PWD/dist/dew-<版>-<コミット>-x86_64-linux/dew pnpm -C tests/e2e exec playwright test
```

## 2. 何も入っていない環境で確かめる(Docker のあるサーバなどで)

開発用コンテナには必要なものが全部入っているので、「足りないときの案内」は素の Ubuntu で確かめる。tar.gz をサーバへ送ってから:

```bash
docker run --rm -it -p 18765:8765 -e DEW_PUBLIC_HOST=<サーバの IP> -e DEW_PUBLIC_PORT=18765 \
  -v "$PWD":/work -w /work ubuntu:24.04 bash
```

コンテナの中で:

```bash
tar xzf dew-*-x86_64-linux.tar.gz && cd dew-*-x86_64-linux
sha256sum -c SHA256SUMS            # dew: OK
./dew --version
./dew doctor                       # 機能ごとに ✓ / ✗ が並び、apt のコマンドが出る(閲覧・再生だけ ✓)
./dew run true                     # 「ライブ描画(dew run / dew env)に要る … がありません」と入れ方が出て止まる
./dew                              # 使えない機能が並び、「ファイルの閲覧と再生はできます」と出て起動する
                                   # ブラウザで開き、MP4 が再生でき、情報の欄に ffprobe がないと出ることを確かめる
./dew stop
apt-get update && apt-get install -y ffmpeg xvfb pulseaudio python3-tk
./dew doctor                       # ✓ になる
./dew                              # URL が出る。Windows のブラウザで開ける
./dew run python3 -c "import tkinter as t; r=t.Tk(); r.title('hello'); r.mainloop()" &
                                   # ブラウザに「hello」のウィンドウが出る
./dew stop
```

`exit` でコンテナは消える(`--rm`)。

## 3. 版を決めて GitHub の Releases に載せる

1. `CHANGELOG.md` にその版の変更点を書き、`Cargo.toml` の `version` を上げて、PR で `main` に入れる
2. `main` で `scripts/release.sh` を実行する(1 の手順)
3. タグを付けて push する(例: v0.1.0)

   ```bash
   git tag -a v0.1.0 -m "dew 0.1.0"
   git push origin v0.1.0
   ```

4. GitHub の Web でリポジトリを開き、右側の「Releases」→「Draft a new release」
   - 「Choose a tag」で `v0.1.0` を選ぶ
   - タイトルは `dew 0.1.0`、本文には `CHANGELOG.md` のその版の部分を貼る
   - 「Attach binaries」に `dist/dew-0.1.0-<コミット>-x86_64-linux.tar.gz` をドラッグする
   - 「Publish release」
5. 友人には、その tar.gz(または Releases のページ)を渡す。リポジトリが非公開なら、Releases のページは友人からは見えないので、tar.gz を直接渡す

`gh` にログインしていれば、4 は `gh release create v0.1.0 dist/dew-0.1.0-*-x86_64-linux.tar.gz --title "dew 0.1.0" --notes-file <本文のファイル>` でもできる。
