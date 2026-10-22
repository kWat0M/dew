# syntax=docker/dockerfile:1
# =============================================================================
# 開発用コンテナ（dew）  使い方は dotfiles/docker/README.md、決めごとは ADR 0027
#   dotfiles の見本（docker/rust）から作った。開発用だけなので、リリースビルド・本番用の
#   ステージ（builder / production）は持たない（配布物は scripts/release.sh で作る）。
#
#     dev-tools（dotfiles/docker/dev-tools/build.sh で作るイメージ）
#                                   │ COPY --from で取り込む
#     base ── toolchain ── development … 開発用コンテナ（compose/compose.yaml）
#
#   base        … 土台・ロケール・証明書
#   toolchain   … ビルドに要るもの（C コンパイラ・ネイティブ依存・Rust・Node.js）
#   development … dev-tools（エディタ・ツール一式）と PC 固有の設定、dew の開発とテストに要るもの
#
#   development の中は、セクション番号で compose/compose.yaml / compose/.env と対応させている:
#     [1] 基本設定 [2] git [3] GUI ウィンドウ（dew） [4] dev-tools [5] Claude Code [6] 言語固有（dew）
# =============================================================================

# dev-tools イメージ（名前は compose/compose.yaml から渡す。dev.sh が .env に書き込む）
ARG DEV_TOOLS_IMAGE=dev-tools:latest
FROM ${DEV_TOOLS_IMAGE} AS dev-tools

# =============================================================================
# base: 土台
# =============================================================================
FROM debian:trixie-slim AS base

# 日本語（全角文字）を正しく扱うためのロケール
ENV LANG=C.UTF-8

# HTTPS で通信するときの証明書
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# =============================================================================
# toolchain: ビルドに要るもの
# =============================================================================
FROM base AS toolchain

# C コンパイラ / リンカ（Rust のリンクと treesitter パーサーのビルドに使う）とダウンロード用の curl。
# clang / nasm / cmake は openh264 などネイティブ依存のビルドに使う。
# musl-tools は配布用の静的リンクビルド（x86_64-unknown-linux-musl）に使う
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config \
    clang nasm cmake musl-tools libopus-dev \
 && rm -rf /var/lib/apt/lists/*

# ツールチェーンは /usr/local に置き、全ユーザーから読み取り専用で使う
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

# rustup で stable を入れる（rustfmt / clippy / rust-src は std の補完・定義ジャンプ用）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
      --component rustfmt,clippy,rust-src \
 && rustup target add x86_64-unknown-linux-musl

# cargo-nextest（テストランナー。公式のビルド済みバイナリ）
RUN curl -LsSf https://get.nexte.st/latest/linux | tar -xz -C /usr/local/cargo/bin

# Node.js + pnpm: Web UI（React + TypeScript + Vite）。
# Node.js は LTS の 24 系（NodeSource）。pnpm は corepack から使う（版は package.json の packageManager で固定）
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

# =============================================================================
# development: 開発用コンテナ（compose/compose.yaml の build.target）
# =============================================================================
# キャッシュを効かせるため、重くてあまり変えないものを先に、よく変えるもの（[4]）を後に置く。
# そのため番号順には並んでいない
FROM toolchain AS development

# -----------------------------------------------------------------------------
# [1] 基本設定
# -----------------------------------------------------------------------------
# 対話シェルを明示する（nvim の 'shell' などはこの値を既定値に使う。未設定だと sh になる）
ENV SHELL=/bin/bash

# dev-tools のツールが使う apt パッケージ（一覧は dev-tools/Dockerfile の冒頭。残りは toolchain で入れている）
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip git openssh-client ripgrep fd-find file jq \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# [2] git: gh
# -----------------------------------------------------------------------------
# GitHub CLI（Releases の公開・取得用。ログイン情報は compose/compose.yaml の [6] でボリュームに残す）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gh \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# [3] GUI ウィンドウ（dew）
# -----------------------------------------------------------------------------
# dew が使う仮想ディスプレイ（xvfb）・音声（pulseaudio）・動画の情報と変換（ffmpeg）。
# どれも dew が自分で起動する。x11-utils / xdotool / pulseaudio-utils はテストでの操作・確認用。
# ffmpeg はテスト素材の生成（scripts/gen-fixtures.sh）にも使う
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11-utils xdotool \
    pulseaudio pulseaudio-utils \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# GUI のプログラムがビルド・実行時に使う X11 / OpenGL のライブラリ（xvfb の上で動く）。
# libgl1-mesa-dri / mesa-utils は OpenGL アプリの表示確認用（ソフトウェア描画）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libx11-dev libxcursor1 libxrandr2 libxi6 libxkbcommon-x11-0 libxkbcommon0 \
    libgl1 libegl1 libgl1-mesa-dri mesa-utils \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# [6] 言語固有（dew）: テストに使うもの（重いので先に入れる）
# -----------------------------------------------------------------------------
# テスト用 GUI アプリ: プログラム無改変での表示確認（cv2.imshow / matplotlib / pygame）。
# Debian の opencv は GUI（highgui）付き。pip ではなく apt で入れる（PEP 668 の制限を避けるため）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-numpy python3-opencv python3-matplotlib python3-tk python3-pygame \
 && rm -rf /var/lib/apt/lists/*

# シェル連携のテスト: dew activate を bash と zsh の両方で確かめる（フェーズ5）。
# rc ファイルへの dew shell-init の追記はしない（利用者が自分で行う。ADR 0022）
RUN apt-get update && apt-get install -y --no-install-recommends \
    zsh \
 && rm -rf /var/lib/apt/lists/*

# E2E: Google Chrome（Playwright の channel: 'chrome' で使う）。
# Playwright 同梱の Chromium は H.264 / AAC を再生できないため、Google Chrome を入れる。
# 日本語 UI のスクリーンショットが文字化けしないよう、日本語フォントも入れる
RUN curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb

# -----------------------------------------------------------------------------
# [1] 基本設定（続き）: 作業ユーザー
# -----------------------------------------------------------------------------
# ホストと UID/GID を合わせ、マウントしたファイルの所有者がずれないようにする（値は .env）。
# UID が変わってもツールチェーンなどを入れ直さないよう、後のほうで作る
ARG UID=1000
ARG GID=1000
RUN groupadd -g ${GID} dev \
 && useradd -m -u ${UID} -g ${GID} -s /bin/bash dev

# [6] 依存クレート・pnpm のストア・gh のログイン情報はユーザー側に置く（compose/compose.yaml の [6] でボリュームにする）
ENV CARGO_HOME=/home/dev/.cargo \
    PNPM_HOME=/home/dev/.local/share/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN install -d -o dev -g dev /home/dev/.cargo /home/dev/.local /home/dev/.local/share \
    /home/dev/.local/share/pnpm /home/dev/.config /home/dev/.config/gh

# -----------------------------------------------------------------------------
# [2] git: ssh の設定
# -----------------------------------------------------------------------------
# ssh の設定・公開鍵・known_hosts だけをコピーする。秘密鍵（.pub で終わらない id_*）は除外する。
# 認証はホストの ssh-agent を転送して行う（compose/compose.yaml の [2]）。
# .pub があると、ssh は Host ごとの IdentityFile に対応する鍵を agent から選んで使う
COPY --from=ssh-config --chown=dev:dev \
     --exclude=**/id_*[^b] --exclude=known_hosts.old --exclude=environment-* \
     . /home/dev/.ssh
# 念のため、秘密鍵が紛れ込んでいたらビルドを失敗させる
RUN chmod 700 /home/dev/.ssh \
 && ! grep -rlq "PRIVATE KEY" /home/dev/.ssh

# -----------------------------------------------------------------------------
# [5] Claude Code: 設定
# -----------------------------------------------------------------------------
# ~/.claude はホストと共有するが（compose/compose.yaml の [5]）、その中の CLAUDE.md などは
# dotfiles へのシンボリックリンク（setup.sh が作る）なので、リンク先と同じパスに置いて解決させる。
# 設定を変えたら ./dev.sh build で反映する
ARG DOTFILES
COPY --from=claude-config --chown=dev:dev . ${DOTFILES}/claude/.claude

# -----------------------------------------------------------------------------
# [4] dev-tools: エディタ・ツール一式を取り込む（中身は dotfiles/docker/dev-tools/Dockerfile）
# -----------------------------------------------------------------------------
# dev-tools を作り直したときは、ここから下だけがやり直しになる
COPY --from=dev-tools /opt/dev-tools /opt/dev-tools
COPY --from=dev-tools --chown=dev:dev /home/dev /home/dev
# dev-tools の ENV は COPY では引き継がれないので、ここで設定する
#   PATH: 開発中の dew（target/debug）、dev-tools の実行ファイル、Claude Code（~/.local/bin）。
#         dev-tools には Release 版の dew も入っているが、手で打った dew は開発中のものを先に使う
#         （cargo build する前は Release 版が動く）
#   EDITOR: yazi や git などが開くエディタ（未設定だと vi が開く）
#   DISABLE_AUTOUPDATER: Claude Code の自動更新を止める（版は dev-tools で固定している）
ARG PROJECT_PATH
ENV PATH=/home/dev/${PROJECT_PATH}/target/debug:/opt/dev-tools/bin:/home/dev/.local/bin:$PATH \
    EDITOR=nvim \
    DISABLE_AUTOUPDATER=1

# -----------------------------------------------------------------------------
# [6] 言語固有（dew）: LSP と treesitter パーサー
# -----------------------------------------------------------------------------
USER dev

# Rust と TypeScript 用の LSP（mason が自動で有効化する）と treesitter パーサー
RUN nvim --headless "+Lazy! load mason.nvim" "+MasonInstall rust-analyzer vtsls" +qa \
 && nvim --headless "+Lazy! load nvim-treesitter" \
    "+lua require('nvim-treesitter').install({'rust','toml','typescript','tsx','javascript','json','css','html','python','yaml','dockerfile'}):wait(300000)" +qa
