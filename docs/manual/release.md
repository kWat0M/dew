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

## 3. 版を決めて、公開のリポジトリ(kWat0M/dew-releases)の Releases に載せる

ソースのリポジトリ(kWat0M/DevView)は非公開のまま、配布物は**バイナリだけを置く公開リポジトリ** `kWat0M/dew-releases` の Releases に載せる。友人はそこから取り、`dew update` もそこを見る(ADR 0018)。

### 初回だけ: 公開リポジトリを作る

1. GitHub の Web で「New repository」→ 名前 `dew-releases`、**Public**、README などは作らない
2. Settings → General → Features で、Issues と Wikis などを外す(受け付けないなら)
3. 中身は README・LICENSE・CHANGELOG だけ(ソースは置かない)。開発用コンテナで:

   ```bash
   mkdir -p /tmp/dew-releases && cd /tmp/dew-releases
   git init -b main
   cp ~/projects/DevView/{README.md,LICENSE,CHANGELOG.md} .
   git add . && git commit -m "dew の配布用リポジトリ"
   git remote add origin git@github.com:kWat0M/dew-releases.git
   git push -u origin main
   ```

### リリースのたび

1. ソースのリポジトリで、`CHANGELOG.md` にその版の変更点を書き、`Cargo.toml` の `version` を上げて、PR で `main` に入れる
2. `main` で `scripts/release.sh` を実行する(1 の手順)
3. ソースのリポジトリにタグを付けて push する(どのコミットから作ったかの記録)

   ```bash
   git tag -a v0.1.0 -m "dew 0.1.0"
   git push origin v0.1.0
   ```

4. 公開リポジトリの README・LICENSE・CHANGELOG を新しいものに差し替えて push する(変わったときだけ)
5. GitHub の Web で `kWat0M/dew-releases` を開き、「Releases」→「Draft a new release」
   - 「Choose a tag」に `v0.1.0` と入れて「Create new tag」(公開リポジトリ側のタグ。`dew update` はこのタグ名で版を比べる)
   - タイトルは `dew 0.1.0`、本文には `CHANGELOG.md` のその版の部分を貼る
   - 「Attach binaries」に `dist/dew-0.1.0-<コミット>-x86_64-linux.tar.gz` をドラッグする
   - 「Publish release」
6. 友人には https://github.com/kWat0M/dew-releases/releases を伝える。すでに入れている人は `dew update` で入れ替わる

`gh` にログインしていれば、5 は `gh release create v0.1.0 dist/dew-0.1.0-*-x86_64-linux.tar.gz --repo kWat0M/dew-releases --title "dew 0.1.0" --notes-file <本文のファイル>` でもできる。
