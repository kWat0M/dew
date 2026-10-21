# syntax=docker/dockerfile:1
# =============================================================================
# 開発用コンテナ（dew）  使い方は dotfiles/docker/README.md
#   [1] 基本設定        … ベースイメージ・ロケール・共通ツール・作業ユーザー
#   [2] git
#   [3] GUI ウィンドウ   … WSLg 経由で Windows にウィンドウを表示する
#   [4] Neovim          … 本体・外部ツール・設定・プラグイン・共通パーサー
#   [5] Claude Code     … claude コマンド（claudecode.nvim から使う）
#   [6] 言語固有（dew）  … Rust・Node.js・仮想ディスプレイ・音声・メディア・E2E
#   [1]〜[5] はテンプレートのまま。[6] を dew 用に書き換えている。
#   compose.yaml / .env も同じ番号でセクション分けしている。
# =============================================================================

# -----------------------------------------------------------------------------
# [1] 基本設定
# -----------------------------------------------------------------------------
FROM debian:trixie-slim

# ホストと UID/GID を合わせ、マウントしたファイルの所有者がずれないようにする（値は .env）
ARG UID=1000
ARG GID=1000

# 日本語（全角文字）を正しく扱うためのロケール
ENV LANG=C.UTF-8
# 対話シェルを明示する（nvim の 'shell' などはこの値を既定値に使う。未設定だと sh になる）
ENV SHELL=/bin/bash

# 各セクションで使う共通ツール（ダウンロード・展開・C コンパイラ / リンカ）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip build-essential \
 && rm -rf /var/lib/apt/lists/*

# 作業ユーザー dev を作成する。
# ~/.config などは、COPY やマウントで root 所有として作られないよう先に作っておく
RUN groupadd -g ${GID} dev \
 && useradd -m -u ${UID} -g ${GID} -s /bin/bash dev \
 && mkdir -p /home/dev/.config /home/dev/.local/share /home/dev/.local/state /home/dev/.cache \
 && chown -R dev:dev /home/dev

# --- シェル（bash）: プロンプトに starship を使う ---
# ホストと同じバージョンに固定する
ARG STARSHIP_VERSION=1.24.2
RUN curl -fsSL https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/starship-x86_64-unknown-linux-musl.tar.gz \
    | tar -xz -C /usr/local/bin starship
# 設定（dotfiles）をコピーし、bash の起動時に starship を読み込む
COPY --from=starship-config --chown=dev:dev starship.toml /home/dev/.config/starship.toml
RUN echo 'eval "$(starship init bash)"' >> /home/dev/.bashrc

# --- 画像の表示: 端末に画像を表示する chafa（使い方: img 画像ファイル...）---
# コンテナには端末を判別するための環境変数が届かないため、
# 形式（sixels / iterm / kitty / symbols）は compose.yaml の IMAGE_FORMAT で指定する
RUN apt-get update && apt-get install -y --no-install-recommends \
    chafa \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'img() { chafa -f "${IMAGE_FORMAT:-sixels}" "$@"; }' >> /home/dev/.bashrc

# --- 画像の表示: ターミナルのファイルマネージャー yazi（選んだ画像をその場でプレビューする）---
# 端末の画像形式は yazi が自分で判別する。file はファイルの種類の判定に必須。
# ファイルを開くエディタは $EDITOR（[4] で nvim にする）
# ffmpeg は dew の変換・サムネイル・テスト素材の生成にも使う（[6]）
ARG YAZI_VERSION=26.9.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    file ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/yazi.zip https://github.com/sxyazi/yazi/releases/download/v${YAZI_VERSION}/yazi-x86_64-unknown-linux-musl.zip \
 && unzip -j /tmp/yazi.zip '*/yazi' '*/ya' -d /usr/local/bin \
 && rm /tmp/yazi.zip

# -----------------------------------------------------------------------------
# [2] git
# -----------------------------------------------------------------------------
# ホストと同じバージョンに固定する
ARG LAZYGIT_VERSION=0.58.1

# git 本体と ssh クライアント（push / pull 用）。git は lazy.nvim や gitsigns でも使う
# gh は dew の配布（非公開 GitHub Releases への公開・取得）に使う
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client gh \
 && rm -rf /var/lib/apt/lists/*

# lazygit（公式リリースのバイナリ）
RUN curl -fsSL https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_x86_64.tar.gz \
    | tar -xz -C /usr/local/bin lazygit

# git の設定（user.name / email など）をコピーする（compose.yaml の additional_contexts から受け取る）
COPY --from=git-config --chown=dev:dev . /home/dev/.config/git

# ssh の設定・公開鍵・known_hosts だけをコピーする。秘密鍵（.pub で終わらない id_*）は除外する。
# 認証はホストの ssh-agent を転送して行う（compose.yaml の [2]）。
# .pub があると、ssh は Host ごとの IdentityFile に対応する鍵を agent から選んで使う
COPY --from=ssh-config --chown=dev:dev \
     --exclude=**/id_*[^b] --exclude=known_hosts.old --exclude=environment-* \
     . /home/dev/.ssh
# 念のため、秘密鍵が紛れ込んでいたらビルドを失敗させる
RUN chmod 700 /home/dev/.ssh \
 && ! grep -rlq "PRIVATE KEY" /home/dev/.ssh

# -----------------------------------------------------------------------------
# [3] GUI ウィンドウ（WSLg）
# -----------------------------------------------------------------------------
# 開発中にテスト用 GUI アプリを Windows 側に直接出して見比べるために残す。
# dew 自体は WSLg を使わず、自前の Xvfb（[6]）に表示させる。
# GUI アプリが実行時に読み込む X11 / Wayland / OpenGL のライブラリ。
# 表示先（ソケットと環境変数）の設定は compose.yaml の [3] で行う
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libx11-dev libxcursor1 libxrandr2 libxi6 libxkbcommon-x11-0 \
    libwayland-client0 libwayland-cursor0 libwayland-egl1 libxkbcommon0 \
    libgl1 libegl1 \
 && rm -rf /var/lib/apt/lists/*

# --- 動画の再生: mpv（yazi で動画を選んで Enter で再生する。映像・音声は WSLg 経由で Windows に出る）---
RUN apt-get update && apt-get install -y --no-install-recommends \
    mpv \
 && rm -rf /var/lib/apt/lists/*

# yazi の既定では、再生は xdg-open に任される（コンテナにはないので何も起きない）。
# 再生（play）を mpv に置き換える。--force-window は音声だけのファイルでもウィンドウを出す
COPY --chown=dev:dev <<'EOF' /home/dev/.config/yazi/yazi.toml
[opener]
play = [
	{ run = "mpv --force-window %s", orphan = true, desc = "Play (mpv)", for = "unix" },
]
EOF

# -----------------------------------------------------------------------------
# [4] Neovim
# -----------------------------------------------------------------------------
# ホストと同じバージョンに固定する
ARG NVIM_VERSION=0.12.2
# nvim-treesitter（main ブランチ）がパーサーのビルドに使う CLI（0.26.1 以上が必要）
ARG TREE_SITTER_VERSION=0.26.5

# プラグインが使う外部ツール（検索用）。Debian の fd は fdfind という名前なので fd でも呼べるようにする
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Neovim 本体と tree-sitter CLI（公式リリースのバイナリ）
RUN curl -fsSL https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/nvim-linux-x86_64.tar.gz \
    | tar -xz -C /opt \
 && ln -s /opt/nvim-linux-x86_64/bin/nvim /usr/local/bin/nvim \
 && curl -fsSL https://github.com/tree-sitter/tree-sitter/releases/download/v${TREE_SITTER_VERSION}/tree-sitter-linux-x64.gz \
    | gunzip > /usr/local/bin/tree-sitter \
 && chmod +x /usr/local/bin/tree-sitter

USER dev

# 設定（dotfiles）をイメージにコピーする（compose.yaml の additional_contexts から受け取る）。
# 設定を変えたら docker compose build で反映する
COPY --from=nvim-config --chown=dev:dev . /home/dev/.config/nvim

# bash でも vi で nvim を開けるようにする（WSL の zshrc の alias vi='nvim' と同じ）
RUN echo "alias vi='nvim'" >> /home/dev/.bashrc
# yazi や git などが開くエディタも nvim にする（未設定だと vi が開く）
ENV EDITOR=nvim

# プラグインを lazy-lock.json の版で入れ、言語に依存しない共通の treesitter パーサーを入れる
RUN nvim --headless "+Lazy! restore" +qa \
 && nvim --headless "+Lazy! load blink.cmp" "+sleep 10" +qa \
 && test -f /home/dev/.local/share/nvim/lazy/blink.cmp/target/release/libblink_cmp_fuzzy.so \
 && nvim --headless "+Lazy! load nvim-treesitter" \
    "+lua require('nvim-treesitter').install({'lua','vim','vimdoc','markdown','markdown_inline','query'}):wait(300000)" +qa

# -----------------------------------------------------------------------------
# [5] Claude Code
# -----------------------------------------------------------------------------
# ホストと同じバージョンに固定する。コンテナ内の自動更新は作り直すと消えるので止め、
# 更新するときはこの値を変えて docker compose build する
ARG CLAUDE_CODE_VERSION=2.1.296
ENV DISABLE_AUTOUPDATER=1 \
    PATH=/home/dev/.local/bin:$PATH

# ~/.local/bin/claude に入る（設定・認証情報は compose.yaml の [5] でホストと共有する）
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION} \
 && claude --version

# 設定（dotfiles の claude/.claude）をコピーする。
# ~/.claude はホストと共有するが（compose.yaml の [5]）、その中の CLAUDE.md などは
# dotfiles へのシンボリックリンク（setup.sh が作る）なので、リンク先と同じパスに置いて解決させる。
# 設定を変えたら docker compose build で反映する
ARG DOTFILES
COPY --from=claude-config --chown=dev:dev .claude ${DOTFILES}/claude/.claude
# 会話履歴の同期スクリプト（claudecode.nvim から使う。zshrc の cla と同じ処理）
COPY --from=claude-config --chmod=755 bin/claude-sync /usr/local/bin/claude-sync

USER root

# ステータスライン（~/.claude/statusline.sh）が JSON を読むのに使う jq
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
 && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# [6] 言語固有（dew: Rust + TypeScript）
# -----------------------------------------------------------------------------

# --- [6-1] Rust: ツールチェーン ---
# ツールチェーンは /usr/local に置き、全ユーザーから読み取り専用で使う
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

# clang / nasm / cmake は openh264 などネイティブ依存のビルドに使う。
# musl-tools は配布用の静的リンクビルド（x86_64-unknown-linux-musl）に使う
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang nasm cmake musl-tools libopus-dev \
 && rm -rf /var/lib/apt/lists/*

# rustup で stable を入れる（rustfmt / clippy / rust-src は std の補完・定義ジャンプ用）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
      --component rustfmt,clippy,rust-src \
 && rustup target add x86_64-unknown-linux-musl

# cargo-nextest（テストランナー。公式のビルド済みバイナリ）
RUN curl -LsSf https://get.nexte.st/latest/linux | tar -xz -C /usr/local/cargo/bin

# 依存クレートのキャッシュなどはユーザー側に置く（compose.yaml の [6] でボリュームにする）
ENV CARGO_HOME=/home/dev/.cargo
RUN install -d -o dev -g dev /home/dev/.cargo

# --- [6-2] Node.js + pnpm: Web UI（React + TypeScript + Vite）---
# Node.js は LTS の 24 系（NodeSource）。pnpm は corepack から使う（版は package.json の packageManager で固定）
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
# pnpm のストアはユーザー側に置く（compose.yaml の [6] でボリュームにする）
ENV PNPM_HOME=/home/dev/.local/share/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN install -d -o dev -g dev /home/dev/.local/share/pnpm /home/dev/.config/gh

# --- [6-3] 仮想ディスプレイと音声: dew run（ライブ描画）の開発と自動テスト ---
# Xvfb は dew が自分で起動する（WSLg の DISPLAY とは別）。xdotool / x11-utils はテストでの操作・確認用。
# pulseaudio も dew が自分で起動する（WSLg の PulseServer とは別）
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11-utils xdotool \
    pulseaudio pulseaudio-utils \
    libgl1-mesa-dri mesa-utils \
 && rm -rf /var/lib/apt/lists/*

# --- [6-4] テスト用 GUI アプリ: プログラム無改変での表示確認（cv2.imshow / matplotlib / pygame）---
# Debian の opencv は GUI（highgui）付き。pip ではなく apt で入れる（PEP 668 の制限を避けるため）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-numpy python3-opencv python3-matplotlib python3-tk python3-pygame \
 && rm -rf /var/lib/apt/lists/*

# --- [6-4b] シェル連携のテスト: dew activate を bash と zsh の両方で確かめる（フェーズ5）---
# rc ファイルへの dew shell-init の追記はしない（利用者が自分で行う。ADR 0022）
RUN apt-get update && apt-get install -y --no-install-recommends \
    zsh \
 && rm -rf /var/lib/apt/lists/*

# --- [6-5] E2E: Google Chrome（Playwright の channel: 'chrome' で使う）---
# Playwright 同梱の Chromium は H.264 / AAC を再生できないため、Google Chrome を入れる。
# 日本語 UI のスクリーンショットが文字化けしないよう、日本語フォントも入れる
RUN curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb

USER dev

# Rust と TypeScript 用の LSP（mason が自動で有効化する）と treesitter パーサー
RUN nvim --headless "+Lazy! load mason.nvim" "+MasonInstall rust-analyzer vtsls" +qa \
 && nvim --headless "+Lazy! load nvim-treesitter" \
    "+lua require('nvim-treesitter').install({'rust','toml','typescript','tsx','javascript','json','css','html','python','yaml','dockerfile'}):wait(300000)" +qa

# -----------------------------------------------------------------------------
# 最終設定
# -----------------------------------------------------------------------------
WORKDIR /workspace
