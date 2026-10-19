"""紹介動画のアプリ: cv2.imshow で跳ねるボール。クリックでボールを足し、g で重力、r でやり直す"""
import random

import cv2
import numpy as np

W, H = 720, 440
balls = []
gravity = True


def add(x, y):
    hue = random.randint(0, 179)
    bgr = cv2.cvtColor(np.uint8([[[hue, 220, 255]]]), cv2.COLOR_HSV2BGR)[0, 0]
    balls.append([float(x), float(y), random.uniform(-6, 6), random.uniform(-8, -2), random.randint(14, 30), tuple(int(c) for c in bgr)])


def on_mouse(event, x, y, flags, param):
    if event == cv2.EVENT_LBUTTONDOWN:
        add(x, y)


for _ in range(5):
    add(random.randint(60, W - 60), random.randint(60, 200))
cv2.namedWindow("balls")
cv2.setMouseCallback("balls", on_mouse)
canvas = np.zeros((H, W, 3), np.uint8)
frame = 0
while True:
    canvas = (canvas * 0.82).astype(np.uint8)  # 残像
    for b in balls:
        if gravity:
            b[3] += 0.5
        b[0] += b[2]
        b[1] += b[3]
        r = b[4]
        if b[0] < r or b[0] > W - r:
            b[2] *= -1
            b[0] = min(max(b[0], r), W - r)
        if b[1] > H - r:
            b[3] *= -0.92 if gravity else -1
            b[1] = H - r
        if b[1] < r:
            b[3] *= -1
            b[1] = r
        cv2.circle(canvas, (int(b[0]), int(b[1])), r, b[5], -1, cv2.LINE_AA)
    out = canvas.copy()
    info = f"frame {frame}   balls {len(balls)}   gravity {'on' if gravity else 'off'}"
    cv2.putText(out, info, (14, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (235, 235, 235), 2, cv2.LINE_AA)
    cv2.putText(out, "click: add ball   g: gravity   r: reset", (14, H - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (150, 150, 150), 1, cv2.LINE_AA)
    cv2.imshow("balls", out)
    frame += 1
    key = cv2.waitKey(16) & 0xFF
    if key == 27:
        break
    if key == ord("g"):
        gravity = not gravity
    if key == ord("r"):
        balls.clear()
