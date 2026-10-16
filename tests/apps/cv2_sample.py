"""フェーズ3のテスト用アプリ: cv2.imshow のサンプル"""
import time

import cv2
import numpy as np

start = time.time()
while time.time() - start < 60:
    img = np.zeros((300, 400, 3), np.uint8)
    cv2.circle(img, (200, 150), int(50 + 40 * abs(np.sin(time.time()))), (0, 200, 255), -1)
    cv2.imshow("cv2 sample", img)
    if cv2.waitKey(30) == 27:
        break
