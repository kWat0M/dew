#!/usr/bin/env bash
# README の紹介動画(scripts/demo)で使う素材を、指定したディレクトリに ffmpeg で作る
# 使い方: scripts/demo/make-media.sh <出力先>
set -euo pipefail
out=${1:?出力先のディレクトリを指定してください}
mkdir -p "$out"/{videos,results,images}
ff() { ffmpeg -v error -y "$@"; }
enc=(-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 96k -shortest)

# 動画: いくつかの合成映像(音付き)
ff -f lavfi -i "mandelbrot=s=1280x720:r=30" -f lavfi -i "sine=f=330:d=30" -t 30 "${enc[@]}" "$out/videos/mandelbrot.mp4"
ff -f lavfi -i "life=s=640x360:r=30:mold=10:ratio=0.3:life_color=#ffbb33:death_color=#2244aa,scale=1280:720:flags=neighbor" \
   -f lavfi -i "sine=f=220:d=30" -t 30 "${enc[@]}" "$out/videos/life.mp4"
ff -f lavfi -i "testsrc2=s=1280x720:r=30" -f lavfi -i "sine=f=550:d=30" -t 30 "${enc[@]}" "$out/videos/testsrc.mp4"

# 比較: 入力と、それに検出の枠を書き足した結果(差分では枠だけが明るく出る)
ff -f lavfi -i "mandelbrot=s=1280x720:r=30" -f lavfi -i "sine=f=330:d=30" -t 30 "${enc[@]}" "$out/results/input.mp4"
ff -i "$out/results/input.mp4" -vf "drawbox=x='560+60*sin(t)':y=250:w=260:h=220:color=yellow@0.95:t=6,drawbox=x=150:y='300+40*sin(t*1.3)':w=180:h=150:color=cyan@0.95:t=6" "${enc[@]}" "$out/results/detected.mp4"
ff -i "$out/results/input.mp4" -vf "edgedetect=low=0.1:high=0.3:mode=colormix" "${enc[@]}" "$out/results/edges.mp4"

# 画像: 入力と処理結果の静止画、連番の画像
ff -ss 4 -i "$out/results/input.mp4" -frames:v 1 "$out/images/input.png"
ff -ss 4 -i "$out/results/detected.mp4" -frames:v 1 "$out/images/detected.png"
for i in 1 2 3 4; do
  ff -ss "$((i * 2))" -i "$out/videos/life.mp4" -frames:v 1 "$out/images/frame_000$i.png"
done
