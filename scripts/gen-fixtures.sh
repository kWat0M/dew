#!/usr/bin/env bash
# テスト素材を tests/fixtures/ に生成する(仕様書 10.4)。
# 映像は testsrc2 にフレーム番号を焼き込み、上端 16px に番号の2進パターン
# (左から bit0、16px 幅の白黒ブロック)を入れて、テストで画素から番号を読めるようにする
set -euo pipefail
cd "$(dirname "$0")/.."
out=tests/fixtures
font=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
rm -rf "$out" && mkdir -p "$out/sub"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# 共通: 640x360、30fps、10秒(300フレーム)、440 Hz の音
dur=10 fps=30
src=(-f lavfi -i "testsrc2=size=640x360:rate=$fps:duration=$dur"
     -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$dur")
bits="geq=lum='if(lt(Y,16),255*mod(floor(N/pow(2,floor(X/16))),2),lum(X,Y))'"
bits+=":cb='if(lt(Y,16*SH),128,cb(X,Y))':cr='if(lt(Y,16*SH),128,cr(X,Y))'"
label="drawtext=fontfile=$font:text='%{frame_num}':start_number=0:x=(w-tw)/2:y=h-th-24:fontsize=64:fontcolor=white:box=1:boxcolor=black"
vf=(-vf "format=yuv420p,$bits,$label")

# そのまま再生できる形式
ff "${src[@]}" "${vf[@]}" -c:v libx264 -preset veryfast -crf 18 -g 30 -c:a aac -b:a 128k -movflags +faststart "$out/h264_aac.mp4"
# 変換が必要な形式(OpenCV の VideoWriter 既定の mp4v、AVI)
ff "${src[@]}" "${vf[@]}" -c:v mpeg4 -tag:v mp4v -q:v 3 -c:a aac -b:a 128k "$out/mp4v.mp4"
ff "${src[@]}" "${vf[@]}" -c:v mpeg4 -tag:v XVID -q:v 3 -c:a libmp3lame "$out/xvid_mp3.avi"
# 画像・入れ子・隠しファイル
ff -f lavfi -i "testsrc2=size=640x360" -frames:v 1 "$out/image.png"
ff -f lavfi -i "testsrc2=size=640x360" -frames:v 1 "$out/image.jpg"
ff -f lavfi -i "testsrc2=size=320x180" -frames:v 1 "$out/sub/nested.webp"
cp "$out/image.png" "$out/.hidden.png"
# 壊れたファイル(変換失敗の表示用)
printf 'not a video' > "$out/broken.mp4"
echo "生成しました: $out"
