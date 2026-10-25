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

## 3. 版を決めて、公開のリポジトリ(kWat0M/dew)の Releases に載せる

ソースのリポジトリ `kWat0M/dew` は公開していて、配布物もその Releases に載せる。友人はそこから取り、`dew update` もそこを見る(ADR 0018、0020)。

### 一度だけ: DevView を dew に改名して公開し、dew-releases を消す(ADR 0020)

1. 公開する前に、公開できないものが履歴にないことを確かめる。`tests/fixtures/` は git 管理外。引き継ぎ文書などに、サーバの IP やホームのパスを書いたコミットを push していないか
2. GitHub の Web で `kWat0M/DevView` の Settings → General → Repository name を `dew` にして「Rename」
3. 同じ Settings の一番下(Danger Zone)の「Change repository visibility」で **Public** にする
4. 開発用コンテナで、手元の push 先を新しい名前に変える(古い名前でも GitHub が転送するが、そろえておく)

   ```bash
   git remote set-url origin git@kWat0M_github:kWat0M/dew.git
   ```

5. `kWat0M/dew` の「Releases」→「Draft a new release」で、既にある `v0.1.0` のタグを選び、`dist/dew-0.1.0-f15acdf-x86_64-linux.tar.gz` を載せる(本文は `CHANGELOG.md` の 0.1.0 の部分)
6. `kWat0M/dew-releases` の Settings の Danger Zone で「Delete this repository」

v0.1.0 の `dew update` は `kWat0M/dew-releases` を見るので、消したあとは「取得できない」と手で入れ替える方法を出す。0.1.0 を入れた人には、一度だけ「入れ方」の手順で入れ直してもらう(その版からは `dew update` が `kWat0M/dew` を見る)。

### リリースのたび

1. `CHANGELOG.md` にその版の変更点を書き、`Cargo.toml` の `version` を上げて、PR で `main` に入れる(2つ目の数を上げるときは、`crates/*/Cargo.toml` のクレート同士の依存の `version` も同じ版にする)
2. `main` で `scripts/release.sh` を実行する(1 の手順)
3. タグを付けて push する(`dew update` はこのタグ名で版を比べる)

   ```bash
   git tag -a v0.2.0 -m "dew 0.2.0"
   git push origin v0.2.0
   ```

4. GitHub の Web で `kWat0M/dew` を開き、「Releases」→「Draft a new release」
   - 「Choose a tag」で 3 のタグを選ぶ
   - タイトルは `dew 0.2.0`、本文には `CHANGELOG.md` のその版の部分を貼る
   - 「Attach binaries」に `dist/dew-0.2.0-<コミット>-x86_64-linux.tar.gz` をドラッグする
   - 「Publish release」
5. 友人には https://github.com/kWat0M/dew/releases を伝える。すでに入れている人は `dew update` で入れ替わる

`gh` にログインしていれば、4 は `gh release create v0.2.0 dist/dew-0.2.0-*-x86_64-linux.tar.gz --repo kWat0M/dew --title "dew 0.2.0" --notes-file <本文のファイル>` でもできる。
