"""dew の精度モード(L3、`dew run --exact`)のフック。ユーザーのコードは変えずに、cv2 を import した時点で
cv2.imshow / waitKey などを差し替え、imshow に渡された配列を可逆の PNG にして dew のサーバへ送る(ADR 0017)。

- X のウィンドウは作らない(画面の取り込みと二重にならないように)
- waitKey は、ブラウザの入力モードで押されたキーを返す。待ち時間の扱いは OpenCV と同じ(0 以下はキーが来るまで待つ)
- サーバとのやりとりは Unix ソケット(環境変数 DEW_EXACT_SOCKET)。1通は [ヘッダの長さ 4 バイト][JSON のヘッダ][中身]
"""
import importlib.abc
import importlib.machinery
import json
import os
import socket
import struct
import sys
import threading
import time

_SOCKET = os.environ.get("DEW_EXACT_SOCKET")


class _Conn:
    """サーバへの接続。キーは別のスレッドで受け取って溜めておく"""

    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.lock = threading.Lock()
        self.keys = []
        self.closed = set()
        # dew のサーバとの接続が切れた(dew stop など)
        self.gone = False
        self.cond = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def send(self, header, payload=b""):
        head = json.dumps(dict(header, size=len(payload))).encode()
        try:
            with self.lock:
                self.sock.sendall(struct.pack(">I", len(head)) + head + payload)
        except OSError:
            _quit()

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError
            buf += chunk
        return buf

    def _read(self):
        try:
            while True:
                (n,) = struct.unpack(">I", self._recv_exact(4))
                msg = json.loads(self._recv_exact(n))
                with self.cond:
                    if msg.get("t") == "key":
                        self.keys.append(int(msg["key"]))
                    elif msg.get("t") == "close":
                        self.closed.add(msg.get("name"))
                    self.cond.notify_all()
        except (OSError, ConnectionError, ValueError):
            pass
        with self.cond:
            self.gone = True
            self.cond.notify_all()

    def wait_key(self, delay_ms):
        deadline = None if delay_ms <= 0 else time.monotonic() + delay_ms / 1000
        with self.cond:
            while not self.keys:
                if self.gone:
                    _quit()
                timeout = None if deadline is None else deadline - time.monotonic()
                if timeout is not None and timeout <= 0:
                    return -1
                self.cond.wait(timeout)
            return self.keys.pop(0)


def _quit():
    """dew のサーバが止まった。表示先がなくなったので、長いエラーを出さずに1行だけ出して終わる
    (X のアプリが、仮想ディスプレイが止まると終わるのと同じ)"""
    print("dew: dew のサーバが止まったので終了します", file=sys.stderr, flush=True)
    raise SystemExit(1)


def _to_uint8(cv2, np, mat):
    """imshow と同じ見え方の 8bit にする(float は 0〜1 を 0〜255、16bit は 256 で割る)"""
    a = np.asarray(mat)
    if a.dtype == np.uint8:
        return a
    if a.dtype in (np.float32, np.float64):
        return np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)
    if a.dtype == np.uint16:
        return (a >> 8).astype(np.uint8)
    if a.dtype == np.int8:
        return (a.astype(np.int16) + 128).astype(np.uint8)
    return cv2.convertScaleAbs(a)


def _patch(cv2):
    if getattr(cv2, "_dew_exact", False):
        return
    import numpy as np

    conn = _Conn(_SOCKET)
    encode = cv2.imencode
    png = [int(cv2.IMWRITE_PNG_COMPRESSION), 1]

    def imshow(winname, mat):
        img = _to_uint8(cv2, np, mat)
        ok, buf = encode(".png", img, png)
        if not ok:
            raise ValueError("dew: imshow の画像を PNG にできません")
        h, w = img.shape[:2]
        conn.send({"t": "frame", "name": str(winname), "w": int(w), "h": int(h)}, buf.tobytes())

    def wait_key_ex(delay=0):
        return conn.wait_key(int(delay))

    def wait_key(delay=0):
        k = wait_key_ex(delay)
        return k if k == -1 else k & 0xFF

    def destroy_window(winname):
        conn.send({"t": "destroy", "name": str(winname)})

    def destroy_all_windows():
        conn.send({"t": "destroy_all"})

    get_property = cv2.getWindowProperty

    def get_window_property(winname, prop_id):
        # キャンバスで閉じた窓は、デスクトップで閉じたときと同じく見えない扱いにする
        if prop_id == cv2.WND_PROP_VISIBLE:
            with conn.cond:
                return 0.0 if str(winname) in conn.closed else 1.0
        try:
            return get_property(winname, prop_id)
        except cv2.error:
            return -1.0

    cv2.imshow = imshow
    cv2.waitKey = wait_key
    cv2.waitKeyEx = wait_key_ex
    cv2.pollKey = lambda: wait_key(1)
    cv2.destroyWindow = destroy_window
    cv2.destroyAllWindows = destroy_all_windows
    cv2.namedWindow = lambda *a, **k: None
    cv2.resizeWindow = lambda *a, **k: None
    cv2.moveWindow = lambda *a, **k: None
    cv2.setWindowTitle = lambda *a, **k: None
    cv2.getWindowProperty = get_window_property
    cv2._dew_exact = True


class _Loader(importlib.abc.Loader):
    def __init__(self, loader):
        self.loader = loader

    def create_module(self, spec):
        return self.loader.create_module(spec)

    def exec_module(self, module):
        self.loader.exec_module(module)
        # OpenCV の __init__ は読み込みの途中で sys.modules["cv2"] を差し替えることがあるので、最後のものを直す
        _patch(sys.modules.get("cv2", module))


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != "cv2":
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return spec
        spec.loader = _Loader(spec.loader)
        return spec


def install():
    if not _SOCKET or any(isinstance(f, _Finder) for f in sys.meta_path):
        return
    if "cv2" in sys.modules:
        _patch(sys.modules["cv2"])
    else:
        sys.meta_path.insert(0, _Finder())
