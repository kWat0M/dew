# リモートサーバで「2つのコンテナから同時に使う」確認をするための、テスト専用のイメージ
# (docs/manual/remote-test.md)。dew 本体とテスト素材を入れ、一般ユーザー tester で動かす。
# ビルドの前に、このファイルと同じディレクトリへ dew(musl の静的バイナリ)と fixtures/ を置く
FROM ubuntu:24.04

# dew が使う ffmpeg / ffprobe だけを入れる(ファイル閲覧の確認に Xvfb・pulseaudio は要らない)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# 実際の運用と同じく root ではないユーザーで動かす。素材はホームに置き、dew を引数なしで起動すれば見えるようにする
RUN useradd -m tester
COPY --chmod=755 dew /usr/local/bin/dew
COPY --chown=tester:tester fixtures /home/tester/fixtures
USER tester
WORKDIR /home/tester
