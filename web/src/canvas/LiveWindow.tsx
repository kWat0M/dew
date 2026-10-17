// ライブ描画のウィンドウ(L1、L2): 仮想ディスプレイ上のアプリのウィンドウ1つを、WebCodecs で復号して canvas に描く。
// アプリが閉じたら最後の画面を残して「終了」と出す(7.9)
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { LiveConfig } from '../protocol/LiveConfig';
import type { LiveInput } from '../protocol/LiveInput';
import { ja } from '../i18n/ja';
import type { PlayerApi } from './PlayerWindow';
import { WindowFrame, type FrameProps } from './WindowFrame';

/** 復号を待っているフレームがこれより多ければ、次のキーフレームまで飛ばす(遅延を積み上げない。6.1 の 6) */
const MAX_QUEUE = 3;

export type LiveInfo = { id: number; title: string; width: number; height: number; ended: boolean };

type Props = FrameProps & {
  live: LiveInfo;
  /** 入力モード(キー・マウスをアプリへ送る。L6、5.5) */
  inputMode: boolean;
  onExitInput: () => void;
  api: Ref<PlayerApi | null>;
};

/** キャンバスから使うライブウィンドウだけの操作(I の文字列の送信、w r の大きさ合わせ) */
export type LiveApi = PlayerApi & { sendText?: (text: string) => void; fitApp?: () => void };

export function LiveWindow({ api: apiRef, live, inputMode, onExitInput, ...p }: Props) {
  const socket = useRef<WebSocket | null>(null);
  const send = (ev: LiveInput) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(ev));
  };
  const canvas = useRef<HTMLCanvasElement>(null);
  const win = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (live.ended) return;
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    let decoded = 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (el.width !== frame.displayWidth || el.height !== frame.displayHeight) {
          el.width = frame.displayWidth;
          el.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        // 受信 fps の確かめに使う(描くたびに再描画しないよう、属性を直接書く)
        decoded += 1;
        win.current?.setAttribute('data-decoded', String(decoded));
      },
      error: (e) => setError(String(e)),
    });
    let waitKey = true;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live/${live.id}`);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    ws.onmessage = (m) => {
      if (typeof m.data === 'string') {
        const c = JSON.parse(m.data) as LiveConfig;
        decoder.configure({ codec: c.codec, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true });
        setConfig(c);
        return;
      }
      if (decoder.state !== 'configured') return;
      const buf = m.data as ArrayBuffer;
      const view = new DataView(buf);
      const key = (view.getUint8(0) & 1) === 1;
      if (!key && (waitKey || decoder.decodeQueueSize > MAX_QUEUE)) {
        waitKey = true;
        return;
      }
      waitKey = false;
      const timestamp = Number(view.getBigUint64(1));
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: new Uint8Array(buf, 9) }));
    };
    return () => {
      ws.close();
      socket.current = null;
      if (decoder.state !== 'closed') decoder.close();
    };
  }, [live.id, live.ended]);

  // 入力モード: ページのキー入力をすべて受け取り、アプリへ送る。Ctrl+] で抜ける(5.5)
  useEffect(() => {
    const el = win.current;
    el?.setAttribute('data-input', String(inputMode));
    el?.classList.toggle('input-mode', inputMode);
    if (!inputMode) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown' && e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) return onExitInput();
      // 変換中の文字は送らない(日本語は I の送信用の入力欄から)
      if (e.isComposing || e.key === 'Process') return;
      send({ type: 'key', key: e.key, down: e.type === 'keydown' });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKey, { capture: true });
    // 全画面なら Keyboard Lock でブラウザ予約キーも送れる(Chrome / Edge のみ)
    const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
    if (document.fullscreenElement) void kb?.lock?.().catch(() => {});
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKey, { capture: true });
      kb?.unlock?.();
      send({ type: 'release' });
    };
  }, [inputMode, onExitInput]);

  /** canvas 上の位置を、アプリのウィンドウの中の画素にする(object-fit: contain の余白を除く) */
  const toApp = (e: React.PointerEvent | React.WheelEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const scale = Math.min(r.width / c.width, r.height / c.height);
    const offX = (r.width - c.width * scale) / 2;
    const offY = (r.height - c.height * scale) / 2;
    return { x: Math.round((e.clientX - r.left - offX) / scale), y: Math.round((e.clientY - r.top - offY) / scale) };
  };
  const mouse = inputMode
    ? {
        onPointerMove: (e: React.PointerEvent) => send({ type: 'move', ...toApp(e) }),
        onPointerDown: (e: React.PointerEvent) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          send({ type: 'button', button: [1, 2, 3][e.button] ?? 1, down: true, ...toApp(e) });
        },
        onPointerUp: (e: React.PointerEvent) => send({ type: 'button', button: [1, 2, 3][e.button] ?? 1, down: false, ...toApp(e) }),
        onWheel: (e: React.WheelEvent) => {
          const button = e.deltaY < 0 ? 4 : 5;
          send({ type: 'button', button, down: true, ...toApp(e) });
          send({ type: 'button', button, down: false, ...toApp(e) });
        },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      }
    : {};

  // 再生の操作はライブには効かない(録画・巻き戻しはフェーズ4)
  useImperativeHandle(apiRef, (): LiveApi => ({
    // w r: アプリのウィンドウを表示領域の大きさにする。画素はディスプレイの画素(CSS px × 表示倍率)で数え、等倍で映るようにする(7.9)
    fitApp: () => {
      const r = body.current!.getBoundingClientRect();
      send({ type: 'resize', width: Math.round(r.width * devicePixelRatio), height: Math.round(r.height * devicePixelRatio) });
    },
    sendText: (text) => {
      for (const ch of text) {
        send({ type: 'key', key: ch, down: true });
        send({ type: 'key', key: ch, down: false });
      }
    },
    toggle: () => {},
    isPaused: () => false,
    video: () => null,
    setPlaying: () => {},
    seekBy: () => {},
    step: () => {},
    seekFraction: () => {},
    speed: () => {},
    ab: () => {},
    toggleMute: () => {},
    toggleZoom: () => {},
    fullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void win.current?.requestFullscreen();
    },
  }), []);

  return (
    <WindowFrame {...p} testId="live-window" name={live.title || ja.liveUntitled} icon="canvas" sectionRef={win}>
      <div ref={body} className="window-body fit" {...mouse}>
        <canvas ref={canvas} width={live.width} height={live.height} />
        {inputMode && <div className="input-hint">{ja.inputModeHint}</div>}
        {live.ended && <div className="window-overlay ended">{ja.liveEnded}</div>}
        {error && (
          <div className="window-overlay error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className="live-bar">
        <span className={`live-badge${live.ended ? ' ended' : ''}`}>{live.ended ? ja.liveEnded : ja.live}</span>
        {config && (
          <span className="muted">
            {config.width}×{config.height}
          </span>
        )}
      </footer>
    </WindowFrame>
  );
}
