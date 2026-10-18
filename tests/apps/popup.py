"""フェーズ3のテスト用アプリ(tkinter): 一時的な窓(override-redirect。メニューやツールチップと同じ種類)を出す。

- 親の窓 "popup"(400x300、灰色)
- 一時的な窓 "inside"(赤、120x80)を親の左上から (40, 40) の位置に出す
- --outside を付けると、一時的な窓 "outside"(緑、160x80)を親の右下にはみ出す位置(親の (320, 260))にも出す

- --delay 秒 を付けると、一時的な窓をその秒数だけ後に出す(先に開いたほかのアプリのウィンドウに重ねる確認用)

親が動かされても、一時的な窓は親からの位置を保つ(メニューと同じく、アプリが親の位置から計算して置く)。
Tk は表示中の override-redirect の窓を geometry で動かせないので、親の位置が変わったら出し直す。
"""
import argparse
import tkinter as tk


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outside", action="store_true")
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--delay", type=float, default=0.0)
    args = ap.parse_args()

    root = tk.Tk()
    root.title("popup")
    root.geometry("400x300")
    root.configure(bg="#808080")

    popups = [("inside", "#ff0000", 120, 80, 40, 40)]
    if args.outside:
        popups.append(("outside", "#00ff00", 160, 80, 320, 260))
    wins = []
    for name, color, w, h, dx, dy in popups:
        t = tk.Toplevel(root, bg=color, width=w, height=h)
        t.overrideredirect(True)
        t.title(name)
        t.withdraw()
        wins.append((t, w, h, dx, dy))

    shown = {"at": None}

    def follow():
        at = (root.winfo_rootx(), root.winfo_rooty())
        if at != shown["at"]:
            shown["at"] = at
            for t, w, h, dx, dy in wins:
                t.withdraw()
                t.geometry(f"{w}x{h}+{at[0] + dx}+{at[1] + dy}")
                t.deiconify()
                t.lift()
        root.after(100, follow)

    root.after(int(args.delay * 1000), follow)
    root.after(int(args.seconds * 1000), root.destroy)
    root.mainloop()


if __name__ == "__main__":
    main()
