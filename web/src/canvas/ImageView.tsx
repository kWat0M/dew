// 画像の表示(F8): フィット / 等倍(z)、拡大・縮小(+ / - とホイール、拡大は補間なし)、ドラッグで移動、
// マウスを乗せた画素の座標と値の表示。TIFF・16bit はサーバで変換した PNG を出し、16bit の値は元の値を読む
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { api, ApiError } from '../api/http';
import type { Probe } from '../protocol/Probe';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';

/** キャンバスのキーから呼ぶ操作 */
export type ImageApi = { toggleActual(): void; zoomBy(f: number): void };

const MIN_SCALE = 1 / 32;
const MAX_SCALE = 64;

/**
 * 表示位置: scale が null ならフィット。centered なら中央に置く(位置は描画のたびに今の大きさから求めるので、
 * 画像の情報が届く前に切り替えても、ウィンドウの大きさが変わってもずれない)。
 * そうでなければ x, y が画像の左上の位置(表示領域の中の px)
 */
type View = { scale: number | null; centered: boolean; x: number; y: number };
const FIT: View = { scale: null, centered: true, x: 0, y: 0 };

type Pixel = { x: number; y: number; v: number[] };

export function ImageView({ path, api: apiRef, onError, onReady }: { path: string; api: Ref<ImageApi | null>; onError: (m: string) => void; onReady: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(FIT);
  const [pixel, setPixel] = useState<Pixel | null>(null);
  /** 8bit の画素値(表示した画像から読む)と、16bit の元の値(サーバから読む) */
  const rgba8 = useRef<Uint8ClampedArray | null>(null);
  const rgba16 = useRef<Uint16Array | null>(null);
  const loading16 = useRef(false);

  useEffect(() => {
    let alive = true;
    api.probe(path).then(
      (p) => alive && setProbe(p),
      (e: unknown) => alive && onError(e instanceof ApiError ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [path, onError]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = probe?.width ?? 0;
  const h = probe?.height ?? 0;
  const fitScale = w && h && size.w && size.h ? Math.min(size.w / w, size.h / h) : 1;
  const scale = view.scale ?? fitScale;
  const x = view.centered ? (size.w - w * scale) / 2 : view.x;
  const y = view.centered ? (size.h - h * scale) / 2 : view.y;

  /** `f` 倍にする。(cx, cy) の点が動かないようにする(省略時は中央) */
  const zoomBy = useCallback(
    (f: number, cx = size.w / 2, cy = size.h / 2) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * f));
      setView({ scale: next, centered: false, x: cx - ((cx - x) * next) / scale, y: cy - ((cy - y) * next) / scale });
    },
    [scale, x, y, size],
  );
  // 等倍は Windows の表示倍率を打ち消して、ディスプレイの1画素に合わせる(7.9)
  const actual = 1 / (window.devicePixelRatio || 1);
  const toggleActual = useCallback(() => setView(view.scale === actual ? FIT : { scale: actual, centered: true, x: 0, y: 0 }), [view.scale, actual]);
  useImperativeHandle(apiRef, () => ({ toggleActual, zoomBy }), [toggleActual, zoomBy]);

  // ホイールで拡大・縮小(ページのスクロールを止めるため passive にしない)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // ドラッグで移動
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    let px = e.clientX;
    let py = e.clientY;
    let cur: View = { scale, centered: false, x, y };
    const move = (ev: PointerEvent) => {
      cur = { scale: cur.scale, centered: false, x: cur.x + ev.clientX - px, y: cur.y + ev.clientY - py };
      px = ev.clientX;
      py = ev.clientY;
      setView(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // マウスの下の画素(読み込み中の表示が消えたときなど、動かさずに入ってきたときも出す)
  const onPointerMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const ix = Math.floor((e.clientX - r.left - x) / scale);
    const iy = Math.floor((e.clientY - r.top - y) / scale);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return setPixel(null);
    const i = (iy * w + ix) * 4;
    if (probe?.bitDepth === 16) {
      if (!rgba16.current && !loading16.current) {
        loading16.current = true;
        void fetch(api.pixelsUrl(path))
          .then((res) => res.arrayBuffer())
          .then((buf) => {
            const d = new Uint16Array(buf);
            rgba16.current = d;
            // 読み終えたら、今マウスの下にある画素の値を出し直す
            setPixel((px) => {
              if (!px) return px;
              const k = (px.y * w + px.x) * 4;
              return { ...px, v: [d[k]!, d[k + 1]!, d[k + 2]!, d[k + 3]!] };
            });
          });
      }
      const d = rgba16.current;
      setPixel({ x: ix, y: iy, v: d ? [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!] : [] });
    } else {
      const d = rgba8.current;
      setPixel({ x: ix, y: iy, v: d ? [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!] : [] });
    }
  };

  // 表示した画像から 8bit の画素値を読んでおく
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    onReady();
    const img = e.currentTarget;
    // ffprobe がないと大きさが分からないので、読み込んだ画像から取る
    if (probe?.missing.includes('ffprobe')) setProbe({ ...probe, width: img.naturalWidth, height: img.naturalHeight });
    if (probe?.bitDepth === 16) return;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    rgba8.current = ctx.getImageData(0, 0, c.width, c.height).data;
  };

  const src = probe ? (probe.needsTranscode ? api.imageUrl(path) : api.mediaUrl(path)) : null;
  return (
    <>
      <div ref={box} className="image-view" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerEnter={onPointerMove} onPointerLeave={() => setPixel(null)}>
        {src && (
          <img
            src={src}
            alt=""
            draggable={false}
            onLoad={onLoad}
            onError={() => onError(probe?.missing.includes('ffprobe') || probe?.missing.includes('ffmpeg') ? ja.imageNeedsFfmpeg : ja.imageFailed)}
            // 拡大したときは補間しない(画素をそのまま大きくする)
            style={{ left: x, top: y, width: w * scale, height: h * scale, imageRendering: scale > actual ? 'pixelated' : 'auto' }}
          />
        )}
      </div>
      <footer className="image-bar">
        <span className="pixel-info" data-testid="pixel-info">
          {pixel ? `x ${pixel.x}, y ${pixel.y}  ${pixel.v.length ? `R ${pixel.v[0]} G ${pixel.v[1]} B ${pixel.v[2]} A ${pixel.v[3]}` : ja.loading}` : probe ? `${w} × ${h}${probe.bitDepth === 16 ? ' (16bit)' : ''}` : ''}
        </span>
        <span className="spacer" />
        <span className="zoom-level">{Math.round(scale * (window.devicePixelRatio || 1) * 100)}%</span>
        <button type="button" className="icon-button small" title={ja.zoomOut} aria-label={ja.zoomOut} onClick={() => zoomBy(0.8)}>
          <Icon name="zoomOut" size={20} />
        </button>
        <button type="button" className="icon-button small" title={ja.zoomIn} aria-label={ja.zoomIn} onClick={() => zoomBy(1.25)}>
          <Icon name="zoomIn" size={20} />
        </button>
        <button type="button" className="text-button" onClick={() => setView(FIT)}>
          {ja.zoomFit}
        </button>
        <button type="button" className="text-button" onClick={() => setView({ scale: actual, centered: true, x: 0, y: 0 })}>
          {ja.zoomActual}
        </button>
      </footer>
    </>
  );
}
