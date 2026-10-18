"""フェーズ4のテスト用アプリ: cv2.imshow / waitKey を使う、ふつうの OpenCV のプログラム(精度モードの確認用)。

- 乱数(種は固定)の画素の画像を "exact" という窓に出し続ける。圧縮すると崩れる画像なので、画素単位の一致を確かめられる
- 環境変数 DEW_TEST_FRAME があれば、出した画像を RGB の生の画素(幅×高さ×3 バイト)でそのファイルに書く
- 環境変数 DEW_TEST_KEYLOG があれば、waitKey が返したキーを1行ずつ書く

使い方: python3 exact_sample.py [--size 320x240] [--seconds 60]
"""
import argparse
import os
import time

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="320x240")
    ap.add_argument("--seconds", type=float, default=60.0)
    args = ap.parse_args()
    w, h = (int(v) for v in args.size.split("x"))

    img = np.random.default_rng(1234).integers(0, 256, (h, w, 3), dtype=np.uint8)
    out = os.environ.get("DEW_TEST_FRAME")
    if out:
        with open(out, "wb") as f:
            f.write(cv2.cvtColor(img, cv2.COLOR_BGR2RGB).tobytes())
    keylog = os.environ.get("DEW_TEST_KEYLOG")

    start = time.time()
    while time.time() - start < args.seconds:
        cv2.imshow("exact", img)
        key = cv2.waitKey(30)
        if key != -1 and keylog:
            with open(keylog, "a") as f:
                f.write(f"{key}\n")
        if key == 27:
            break
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
