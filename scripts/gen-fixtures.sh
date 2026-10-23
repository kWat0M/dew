#!/usr/bin/env bash
# テスト素材を tests/fixtures/ に生成する(仕様書 10.4)。
# 映像は testsrc2 にフレーム番号を焼き込み、上端 16px に番号の2進パターン
# (左から bit0、16px 幅の白黒ブロック)を入れて、テストで画素から番号を読めるようにする
set -euo pipefail
cd "$(dirname "$0")/.."
out=tests/fixtures
font=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
# 手で置いたファイルを消さないよう、ディレクトリは消さずに上書きする
mkdir -p "$out/sub" "$out/p2"
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
# フェーズ2(比較・画像)。Home の一覧の検査に入らないよう p2/ に置き、テストが必要なときに複製する
# 差分用: image.png の一部だけを塗りつぶしたもの
ff -i "$out/image.png" -vf "drawbox=x=400:y=200:w=80:h=60:color=white:t=fill" "$out/p2/image_b.png"
# 同期再生用: 10 秒の時点を確かめるため 15 秒のもの(そのまま再生できる形式と、変換が必要な形式)
long=(-f lavfi -i "testsrc2=size=640x360:rate=$fps:duration=15" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=15")
ff "${long[@]}" "${vf[@]}" -c:v libx264 -preset veryfast -crf 18 -g 30 -c:a aac -b:a 128k -movflags +faststart "$out/p2/long_h264.mp4"
ff "${long[@]}" "${vf[@]}" -c:v mpeg4 -tag:v mp4v -q:v 3 -c:a aac -b:a 128k "$out/p2/long_mp4v.mp4"
# 16bit PNG と TIFF(ブラウザでそのまま正確に表示できない形式)
ff -i "$out/image.png" -pix_fmt rgb48be "$out/p2/image16.png"
ff -i "$out/image.png" "$out/p2/image.tif"
# フェーズ6(Markdown)。Home の一覧の検査に入らないよう md/ に置き、テストが必要なときに複製する
mkdir -p "$out/md/img" "$out/md/docs"
cp "$out/image.png" "$out/md/img/pic.png"
# 全要素: 見出し・表・タスクリスト・打ち消し線・数式(誤りを含む)・色分けしたコード・フロントマター
cat > "$out/md/all.md" <<'MD'
---
title: 全要素の見本
tags: [dew, test]
---

# 全要素の見本

本文の段落。**太字**、*斜体*、~~打ち消し線~~、`インラインのコード`。[見出しへ](#表)

## 表

| 名前 | 値 | 説明 |
| --- | ---: | :---: |
| alpha | 1 | 最初 |
| beta | 22 | 二番目 |

## タスクリスト

- [x] 済んだこと
- [ ] まだのこと

## 数式

インライン $E = mc^2$ と、ブロック:

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

誤った数式 $\frac{1}{$ はその式だけ error 色になる。

## コード

```python
def hello(name: str) -> str:
    return f"hello {name}"  # コメント
```

```rust
fn main() {
    println!("{}", 1 + 2);
}
```

> 引用の段落

1. 番号付き
2. リスト
MD
# 相対リンクで互いにつながる2ファイル。a.md は長くして、戻ったときのスクロール位置を確かめる
{
  echo '# A の文書'
  echo
  echo '[全要素の見本へ](all.md)'
  echo
  for i in $(seq 1 60); do echo "A の段落 $i。スクロールの確認用の文です。"; echo; done
  echo '[B へ移動](docs/b.md)'
  echo
  echo '[画像を見る](img/pic.png)'
  echo
  for i in $(seq 61 80); do echo "A の段落 $i。"; echo; done
} > "$out/md/a.md"
cat > "$out/md/docs/b.md" <<'MD'
# B の文書

[A へ戻る](../a.md)

[上のディレクトリ](..)
MD
# 画像: 相対・閲覧範囲の外(テストでは md/ を範囲の起点の直下に置くので ../../ は外)・外部・data:
cat > "$out/md/images.md" <<'MD'
# 画像

![相対の画像](img/pic.png)

![範囲外の画像](../../outside.png)

![外部の画像](https://example.invalid/remote.png)

![data の画像](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)
MD
# 危険なリンクや HTML(どれも実行されてはいけない)
cat > "$out/md/danger.md" <<'MD'
# 危険な内容

[スクリプトのリンク](javascript:window.__dewPwned=1)

<script>window.__dewPwned = 1</script>

<img src="x" onerror="window.__dewPwned=1">

<a href="javascript:window.__dewPwned=1">生のリンク</a>

[data の HTML](data:text/html,<script>window.__dewPwned=1</script>)

[外部のリンク](https://example.invalid/)
MD
# Shift_JIS(Excel やふるい Windows のエディタで作った文書)
python3 -c 'import sys; sys.stdout.buffer.write("# 日本語の見出し\n\nこれは Shift_JIS で書いた文書です。ソースコード表示（全角括弧）も含みます。\n".encode("cp932"))' > "$out/md/sjis.md"
echo "生成しました: $out"

# フェーズ7(CSV)。Home の一覧の検査に入らないよう csv/ に置き、テストが必要なときに複製する。
# 乱数の種を固定して、いつ作っても同じ中身にする(小規模モードと大規模モードの結果の一致を確かめるため)
mkdir -p "$out/csv"
python3 -I - "$out/csv" <<'PY'
import csv, random, sys
out = sys.argv[1]

def table(path, rows, memo_len):
    """id(整数)・name(文字列。大文字小文字だけ違う値や同じ値を混ぜる)・score(小数。空あり)・day(日付)・flag(真偽値)・memo"""
    r = random.Random(7)
    names = ['alpha', 'Alpha', 'beta', 'Beta', 'gamma', 'delta', 'abc', 'ABD', 'über', 'Zeta', '日本', 'にほん', '']
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['id', 'name', 'score', 'day', 'flag', 'memo'])
        for i in range(rows):
            name = r.choice(names) + (str(r.randrange(50)) if r.random() < 0.5 else '')
            score = '' if r.random() < 0.05 else f'{r.uniform(-1000, 1000):.6f}'
            day = f'2026-{r.randrange(1, 13):02d}-{r.randrange(1, 29):02d}'
            flag = r.choice(['true', 'false', 'TRUE', 'False'])
            memo = '' if r.random() < 0.1 else 'm' * r.randrange(1, memo_len)
            w.writerow([i + 1, name, score, day, flag, memo])

table(f'{out}/rows10k.csv', 10_000, 20)
table(f'{out}/rows1m.csv', 1_000_000, 120)

# Excel が出力する形: Shift_JIS(CP932)、CRLF
with open(f'{out}/sjis.csv', 'w', newline='', encoding='cp932') as f:
    w = csv.writer(f, lineterminator='\r\n')
    w.writerow(['名前', '年齢', '住所'])
    w.writerow(['山田太郎', '30', '東京都千代田区'])
    w.writerow(['鈴木花子', '25', '大阪府大阪市（北区）'])

# 引用符の中の改行・カンマ・"" のエスケープ
with open(f'{out}/quoted.csv', 'w', newline='', encoding='utf-8') as f:
    f.write('key,text\n')
    f.write('a,"1行目\n2行目"\n')
    f.write('b,"カンマ, を含む"\n')
    f.write('c,"引用符 ""です"""\n')

# 列数が不揃いな行(足りない行が1つ、多い行が2つ)
with open(f'{out}/ragged.csv', 'w', newline='', encoding='utf-8') as f:
    f.write('a,b,c\n1,2,3\n4,5\n6,7,8,9\n10,11,12,13,14\n15,16,17\n')

# 1,000 列
with open(f'{out}/wide.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow([f'c{i}' for i in range(1, 1001)])
    for r in range(1, 51):
        w.writerow([f'r{r}c{i}' for i in range(1, 1001)])

# 列名と値に SQL で特別な意味を持つ記号
with open(f'{out}/symbols.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['say "hi"', "it's", 'a;b', 'x--y'])
    w.writerow(['he said "yes"', "don't", 'semi;colon', 'drop -- table'])
    w.writerow(['plain', 'plain', 'plain', 'plain'])
    w.writerow(["'; DROP TABLE t; --", '"', ';', '--'])

# タブ区切り
with open(f'{out}/tabs.tsv', 'w', newline='', encoding='utf-8') as f:
    f.write('k\tv\nx\t1\ny\t2\n')
PY
