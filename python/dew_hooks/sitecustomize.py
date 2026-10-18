"""dew の精度モード(`dew run --exact`)が PYTHONPATH の先頭に置く sitecustomize。
cv2 のフックを入れてから、もともとあった sitecustomize があればそれも読み込む(連鎖。spec 3.3)。"""
import importlib.util
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))


def _chain():
    # 自分より後ろの sys.path にある sitecustomize を探して読み込む
    for entry in sys.path:
        if not entry or os.path.abspath(entry) == _here:
            continue
        path = os.path.join(entry, "sitecustomize.py")
        if os.path.isfile(path):
            spec = importlib.util.spec_from_file_location("_dew_chained_sitecustomize", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return


try:
    import dew_exact

    dew_exact.install()
except Exception as e:  # フックに失敗しても、アプリはふつうに動かす
    print(f"dew: 精度モードのフックを入れられません: {e}", file=sys.stderr)

_chain()
