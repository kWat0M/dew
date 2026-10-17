"""フェーズ3のテスト用アプリ(pygame)。プログラムは dew のことを何も知らない、ふつうの GUI アプリ。

- 上端 16px: フレーム番号を左から bit0 の 16px 幅の白黒ブロックで焼き込む(tests/fixtures と同じ形式)
- 次の 16px: 描いた時刻(UNIX エポックからのミリ秒の下位 32bit)を同じ形式で焼き込む。受け取った側の時刻との差が遅延
- 440 Hz の音を鳴らし続ける(--tone 0 で止める)
- 受け取ったキーを、環境変数 DEW_TEST_KEYLOG のファイルに1行ずつ書く

使い方: python3 counter.py [--size 640x360] [--fps 60] [--tone 440] [--seconds 0] [--title counter] [--resizable]

--resizable を付けると、ウィンドウの大きさが外から変えられたとき、その大きさで描き直す(w r の確認用)
"""
import argparse
import math
import os
import time

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
import numpy as np  # noqa: E402
import pygame  # noqa: E402

BLOCK = 16


def draw_bits(surface, value, row, bits):
    for bit in range(bits):
        on = (value >> bit) & 1
        surface.fill((255, 255, 255) if on else (0, 0, 0), (bit * BLOCK, row * BLOCK, BLOCK, BLOCK))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="640x360")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--tone", type=float, default=440.0)
    ap.add_argument("--seconds", type=float, default=0.0)
    ap.add_argument("--title", default="counter")
    ap.add_argument("--resizable", action="store_true")
    args = ap.parse_args()
    w, h = (int(v) for v in args.size.split("x"))

    pygame.init()
    screen = pygame.display.set_mode((w, h), pygame.RESIZABLE if args.resizable else 0)
    pygame.display.set_caption(args.title)
    font = pygame.font.Font(None, max(48, h // 4))

    if args.tone > 0:
        pygame.mixer.init(frequency=48000, size=-16, channels=2)
        # 求めた周波数で開けるとは限らないので、実際の周波数で波形を作る(違うと音の高さがずれる)
        rate = pygame.mixer.get_init()[0]
        t = np.arange(rate) / float(rate)
        wave = (np.sin(2 * math.pi * args.tone * t) * 12000).astype(np.int16)
        pygame.sndarray.make_sound(np.column_stack([wave, wave])).play(loops=-1)

    keylog = os.environ.get("DEW_TEST_KEYLOG")
    clock = pygame.time.Clock()
    start = time.time()
    n = 0
    while True:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                return
            if ev.type == pygame.KEYDOWN and keylog:
                with open(keylog, "a") as f:
                    f.write((ev.unicode or pygame.key.name(ev.key)) + "\n")
        if args.seconds and time.time() - start > args.seconds:
            return
        screen = pygame.display.get_surface()
        w, h = screen.get_size()
        screen.fill((40, 80, 160))
        text = font.render(str(n), True, (255, 255, 255))
        screen.blit(text, text.get_rect(center=(w // 2, h // 2)))
        draw_bits(screen, n, 0, 20)
        draw_bits(screen, int(time.time() * 1000) & 0xFFFFFFFF, 1, 32)
        pygame.display.flip()
        n += 1
        clock.tick(args.fps)


if __name__ == "__main__":
    main()
