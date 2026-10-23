# 開発中の dew をビルドして試す(フェーズ5・6)

開発用コンテナの中で、手元のソースからビルドした dew を `dew` で呼べるようにし、自動テストと人の確認を行う手順。

## 0. どのブランチで試すか

| 試すもの | ブランチ |
|---|---|
| フェーズ5(シェル連携・外部ツール連携) | `main`(PR #13 でマージ済み) |
| フェーズ5 と 6(ドキュメントウィンドウ・Markdown) | `phase-6`(フェーズ5を含む) |

```bash
cd ~/projects/DevView
git switch phase-6        # フェーズ5だけなら main
```

## 1. ビルド

```bash
pnpm -C web install       # コンテナを作り直したあとは1回
pnpm -C web build         # 画面(web/dist)
cargo build -p dew        # target/debug/dew
```

デバッグビルドの dew は、画面を実行時に `web/dist` から読む。画面だけ直したときは `pnpm -C web build` だけでよい(ページを読み直せば変わる)。

## 2. `dew` にパスを通す

`~/.local/bin` は開発用コンテナで PATH に入っているので、そこにビルドした dew へのリンクを置く。リンクなので、ビルドし直しても置き直さなくてよい。

```bash
ln -sf "$PWD/target/debug/dew" ~/.local/bin/dew
hash -r                   # 今のシェルが覚えている場所を忘れさせる
which dew                 # ~/.local/bin/dew
dew --version
```

- `alias dew=…` は使わない。`dew activate` のシェル関数は `command dew` で本体を呼ぶので、alias では動かない(フェーズ3・4の手順書は alias で書いている)
- 配布物と同じ形(画面をバイナリに埋め込む)で試すなら `cargo build --release -p dew` にして、リンク先を `target/release/dew` にする
- やめるときは `rm ~/.local/bin/dew`

## 3. ビルドし直したら、サーバを止める

dew は動いているサーバを使い回すので、ビルドし直しても `dew stop` するまでは古いサーバのまま(起動時に「前にビルドしたものです」と警告が出る)。

```bash
dew stop                  # activate 中のシェルがあれば確認が出る。確認なしなら dew stop --force
dew
```

## 4. 自動テスト

テストは `target/debug/dew` を直接使い、使い捨ての HOME で動かすので、2. のリンクや自分のサーバには影響しない。

```bash
scripts/gen-fixtures.sh                         # テスト素材(コンテナを作り直したあとは1回)
cd tests/e2e && npx playwright install firefox && cd ../..   # コンテナを作り直したあとは1回

# フェーズ5・6だけ
cargo nextest run -p dew --test phase5 --test phase6
pnpm -C tests/e2e exec playwright test specs/phase5.spec.ts specs/phase6.spec.ts --project chrome --project firefox

# 全部
cargo nextest run
pnpm -C web test
pnpm -C tests/e2e exec playwright test
```

E2E はビルド済みの `web/dist` と `target/debug/dew` を使うので、先に 1. を済ませる。

## 5. 人が確かめる

- フェーズ5: `docs/manual/phase5-check.md`(`dew setup-shell` は自分の `~/.bashrc` に1行足す。やめるときはその行を消す)
- フェーズ6: `docs/manual/phase6-check.md`(素材は `tests/fixtures/md/`)

試したあとのトークン・仮想ディスプレイの番号・ポートは `~/.local/share/dew/` に残る。まっさらにするなら `dew stop` のあと `rm -rf ~/.local/share/dew ~/.cache/dew`。
