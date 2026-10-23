#!/bin/bash
# 開発コンテナに入る。ホストの UID/GID でビルドし、前回と UID が違えば作り直す
#   ./dev.sh        … 起動して入る（dev-tools イメージがなければ先にビルドする）
#   ./dev.sh build  … dev-tools とこのコンテナをビルドし直して入る（dotfiles や Dockerfile を変えたとき）
#   ./dev.sh down   … 停止・削除（キャッシュ用のボリュームは残す）
set -euo pipefail
# compose ファイルと .env は compose/ にある
cd "$(dirname "$0")/compose"

SERVICE=dew
# [6] キャッシュ用ボリュームのマウント先（compose/compose.yaml の [6]）
CACHE_DIRS=(/home/dev/.cargo /home/dev/.local/share/pnpm /home/dev/.config/gh)

export HOST_UID=$(id -u) HOST_GID=$(id -g)

# docker compose を直接使えるよう、.env にも書いておく（compose はどのシェルから実行しても .env を読む）
set_env() {
  if grep -qs "^$1=" .env; then
    # 値に / が入ることがある（DEV_TOOLS_IMAGE など）ので、区切りに | を使う
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    # 最後の行に改行がなければ足してから追記する
    [ -s .env ] && [ -n "$(tail -c1 .env)" ] && echo >> .env
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
set_env HOST_UID "$HOST_UID"
set_env HOST_GID "$HOST_GID"

# .env の値を読む（なければ空）
get_env() { sed -n "s/^$1=//p" .env 2>/dev/null || true; }

# 取り込む dev-tools イメージの名前。.env で指定がなければ build.sh の既定と同じにする
# （サーバーでは Docker を他のユーザーと共有するので、ユーザー名を入れて名前がぶつからないようにする）
DEV_TOOLS_IMAGE=$(get_env DEV_TOOLS_IMAGE)
export DEV_TOOLS_IMAGE=${DEV_TOOLS_IMAGE:-dev-tools-$(id -un):latest}
set_env DEV_TOOLS_IMAGE "$DEV_TOOLS_IMAGE"

# dev-tools をビルドする（変更がなければキャッシュを使う）。--if-missing: イメージがないときだけ
build_dev_tools() {
  if [ "${1:-}" = --if-missing ] && docker image inspect "$DEV_TOOLS_IMAGE" >/dev/null 2>&1; then
    return
  fi
  local dotfiles
  dotfiles=$(get_env DOTFILES)
  bash "${dotfiles:?.env に DOTFILES を設定してください}/docker/dev-tools/build.sh"
}

# 前回のコンテナ（停止中も含む）をビルドしたときの UID（compose/compose.yaml の labels）
id=$(docker compose ps -aq "$SERVICE")
prev_uid=$([ -n "$id" ] && docker inspect -f '{{index .Config.Labels "dev.uid"}}' "$id" || true)

case "${1:-}" in
  down)
    exec docker compose down ;;
  build)
    build_dev_tools
    docker compose up -d --build ;;
  "")
    if [ -z "$id" ] || [ "$prev_uid" != "$HOST_UID" ]; then
      # コンテナがない、または UID が前回と違う: ビルドして作り直す
      build_dev_tools --if-missing
      docker compose up -d --build
    else
      # 同じ UID: 停止中なら起動するだけ（起動中なら何もせず、入っているシェルも切らない）
      docker compose start
    fi ;;
  *)
    echo "使い方: $0 [build|down]" >&2
    exit 1 ;;
esac

# キャッシュ用のボリュームは作り直しても残り、持ち主も前の UID のまま。
# 違っていれば、中身は残したまま新しい UID の持ち物にする
for dir in "${CACHE_DIRS[@]}"; do
  if [ "$(docker compose exec -T "$SERVICE" stat -c %u "$dir")" != "$HOST_UID" ]; then
    echo "$dir の持ち主を UID $HOST_UID に合わせます"
    docker compose exec -T -u root "$SERVICE" chown -R "$HOST_UID:$HOST_GID" "$dir"
  fi
done

exec docker compose exec "$SERVICE" zsh
