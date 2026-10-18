"""フェーズ3のテスト用アプリ: matplotlib のサンプル(ふつうの plt.show())"""
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 2 * np.pi, 200)
plt.plot(x, np.sin(x))
plt.title("mpl sample")
plt.show()
