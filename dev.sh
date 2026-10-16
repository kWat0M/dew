#!/bin/bash
# 開発コンテナに入る。ホストの UID/GID でビルドし、前回と UID が違えば作り直す
#   ./dev.sh        … 起動して入る
#   ./dev.sh build  … ビルドし直して入る（dotfiles や Dockerfile を変えたとき）
#   ./dev.sh down   … 停止・削除（キャッシュ用のボリュームは残す）
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=dew
# [6] キャッシュ用ボリュームのマウント先（compose.yaml の [6]）
CACHE_DIRS=(/home/dev/.cargo /home/dev/.local/share/pnpm /home/dev/.config/gh)

export HOST_UID=$(id -u) HOST_GID=$(id -g)

# 前回のコンテナ（停止中も含む）をビルドしたときの UID（compose.yaml の labels）
id=$(docker compose ps -aq "$SERVICE")
prev_uid=$([ -n "$id" ] && docker inspect -f '{{index .Config.Labels "dev.uid"}}' "$id" || true)

case "${1:-}" in
  down)
    exec docker compose down ;;
  build)
    docker compose up -d --build ;;
  "")
    if [ -z "$id" ] || [ "$prev_uid" != "$HOST_UID" ]; then
      # コンテナがない、または UID が前回と違う: ビルドして作り直す
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

exec docker compose exec "$SERVICE" bash
