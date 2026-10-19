#!/usr/bin/env bash
# README の紹介動画を撮る。素材を作り、Playwright(Chrome)で操作を録画して、docs/demo/ に MP4 と GIF を書き出す
# 使い方: scripts/demo/record.sh [撮る動画の名前の一部(例: 1-home)]
# 素材は $DEW_DEMO_DIR/my-project に作る(Home のパンくずに出るので、短いパスにしておく)
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=${DEW_DEMO_DIR:-/tmp/dew-demo}
media=$work/my-project
out=$repo/docs/demo
results=$work/results

pnpm -C "$repo/web" build >/dev/null
cargo build -q -p dew --manifest-path "$repo/Cargo.toml"
rm -rf "$media" "$results"
"$repo/scripts/demo/make-media.sh" "$media"
mkdir -p "$media/src" && cp "$repo"/scripts/demo/apps/*.py "$media/src/"

cd "$repo/tests/e2e"
DEW_DEMO_MEDIA=$media DEW_DEMO_OUT=$results npx playwright test -c demo.config.ts "$@"

mkdir -p "$out"
for video in "$results"/*/video.webm; do
  name=$(basename "$(dirname "$video")" | grep -oE '[0-9]+-[a-z]+' | head -1)
  # 読み込みの白い画面を少し落とす
  ffmpeg -v error -y -ss 0.8 -i "$video" -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart -an "$out/$name.mp4"
  ffmpeg -v error -y -ss 0.8 -i "$video" -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out/$name.gif"
  echo "$out/$name.mp4 $(du -h "$out/$name.mp4" | cut -f1)  $out/$name.gif $(du -h "$out/$name.gif" | cut -f1)"
done
