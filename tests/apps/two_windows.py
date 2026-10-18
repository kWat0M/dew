"""フェーズ3のテスト用アプリ: OpenCV で2つの窓を開く(キャンバスに2つのウィンドウが出ることの確認用)"""
import time

import cv2
import numpy as np

seconds = 60
start = time.time()
n = 0
while time.time() - start < seconds:
    for name, color in (("left", (160, 80, 40)), ("right", (40, 160, 80))):
        img = np.full((240, 320, 3), color, np.uint8)
        cv2.putText(img, f"{name} {n}", (20, 130), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
        cv2.imshow(name, img)
    if cv2.waitKey(30) == 27:
        break
    n += 1
