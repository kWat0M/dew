# リモートサーバで dew を確かめるための、テスト専用のイメージ(docs/manual/remote-test.md)。
# 「2つのコンテナから同時に使う」確認(フェーズ1)と、ライブ描画の確認(フェーズ3)に使う。
# dew 本体・テスト素材・テスト用アプリを入れ、一般ユーザー tester で動かす。
# ビルドの前に、このファイルと同じディレクトリへ dew(musl の静的バイナリ)と fixtures/・apps/ を置く
FROM ubuntu:24.04

# dew の実行時の依存(ffmpeg、Xvfb、pulseaudio。spec 7.10)と、テスト用アプリが使う Python のライブラリ。
# pulseaudio-utils(pactl)はわざと入れない(dew は pactl なしで音を振り分ける。ADR 0013)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg xvfb pulseaudio \
      python3 python3-numpy python3-pygame python3-tk python3-matplotlib python3-opencv \
 && rm -rf /var/lib/apt/lists/*

# 実際の運用と同じく root ではないユーザーで動かす。素材はホームに置き、dew を引数なしで起動すれば見えるようにする
RUN useradd -m tester
COPY --chmod=755 dew /usr/local/bin/dew
COPY --chown=tester:tester fixtures /home/tester/fixtures
COPY --chown=tester:tester apps /home/tester/apps
USER tester
WORKDIR /home/tester
