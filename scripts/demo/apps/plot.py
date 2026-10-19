"""紹介動画のアプリ: matplotlib で、学習の損失の曲線が伸びていく様子"""
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FuncAnimation

rng = np.random.default_rng(0)
steps = np.arange(400)
loss = 2.2 * np.exp(-steps / 90) + 0.15 + rng.normal(0, 0.05, steps.size)
val = 2.3 * np.exp(-steps / 110) + 0.25 + rng.normal(0, 0.03, steps.size)

fig, ax = plt.subplots(figsize=(6, 4))
fig.canvas.manager.set_window_title("training")
(l1,) = ax.plot([], [], label="train loss")
(l2,) = ax.plot([], [], label="val loss")
ax.set_xlim(0, 400)
ax.set_ylim(0, 2.6)
ax.set_xlabel("step")
ax.legend()
ax.grid(alpha=0.3)


def update(i):
    n = i * 2 % 400 + 1
    l1.set_data(steps[:n], loss[:n])
    l2.set_data(steps[:n], val[:n])
    return l1, l2


anim = FuncAnimation(fig, update, interval=50, blit=False, cache_frame_data=False)
plt.show()
