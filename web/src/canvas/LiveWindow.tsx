// ライブ描画のウィンドウ(L1、L2): 仮想ディスプレイ上のアプリのウィンドウ1つを、WebCodecs で復号して canvas に描く。
// アプリが閉じたら最後の画面を残して「終了」と出す(7.9)
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { LiveConfig } from '../protocol/LiveConfig';
import type { LiveInput } from '../protocol/LiveInput';
import { api } from '../api/http';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { useCompact } from '../useCompact';
import { useLiveSound, type LiveAudioMix } from './liveAudio';
import { LiveControls } from './LiveControls';
import { LiveRewind, type Chunk } from './liveRewind';
import type { PlayerApi } from './PlayerWindow';
import { WindowFrame, type FrameProps } from './WindowFrame';

/** 復号を待っているフレームがこれより多ければ、次のキーフレームまで飛ばす(遅延を積み上げない。6.1 の 6) */
const MAX_QUEUE = 3;

/** audio: そのウィンドウのアプリの音がある(7.6) */
/** exact: 精度モード(L3)の cv2.imshow の窓。録画・巻き戻しはできない */
export type LiveInfo = { id: number; title: string; width: number; height: number; audio: boolean; recording: boolean; exact: boolean; ended: boolean };

type Props = FrameProps & {
  live: LiveInfo;
  audioMix: LiveAudioMix;
  /** アプリの音を鳴らすか(フォーカス中など。動画のウィンドウと同じ決め方。7.6) */
  audible: boolean;
  onMessage: (m: string) => void;
  /** 巻き戻しに入った・抜けた(キャンバスがヒントの帯を出し分ける) */
  onRewind: (on: boolean) => void;
  /** 入力モード(キー・マウスをアプリへ送る。L6、5.5)。キーはキャンバスが受け取って sendKey で送る */
  inputMode: boolean;
  /** タイトルバーの入力モードのボタン */
  onToggleInput: () => void;
  api: Ref<PlayerApi | null>;
};

/** キャンバスから使うライブウィンドウだけの操作(I の文字列の送信、w r の大きさ合わせ、閉じるときにアプリへ頼む) */
export type LiveApi = PlayerApi & {
  sendText?: (text: string) => void;
  fitApp?: () => void;
  closeApp?: () => void;
  toggleRecord?: () => void;
  /** 巻き戻し中なら、巻き戻しを終えてライブに戻る(G) */
  goLive?: () => void;
  /** 入力モードのキーをアプリへ送る(key は KeyboardEvent.key) */
  sendKey?: (key: string, down: boolean) => void;
  /** キーを押して離す(複数のウィンドウへ同じキーを送るとき) */
  tapKey?: (key: string) => void;
  /** 押したままのキーを離す(入力モードを抜けるとき) */
  release?: () => void;
};

export function LiveWindow({ api: apiRef, live, audioMix, audible, onMessage, onRewind, inputMode, onToggleInput, ...p }: Props) {
  const socket = useRef<WebSocket | null>(null);
  const send = (ev: LiveInput) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(ev));
  };
  const canvas = useRef<HTMLCanvasElement>(null);
  const win = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** このウィンドウだけのミュート(m とバーのボタン。全体のミュートとは別。7.6) */
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  useLiveSound(audioMix, live.audio && !live.ended ? `/ws/live-audio/${live.id}` : null, audible && !muted ? volume : 0);
  /** フィット / 等倍(z) */
  const [fit, setFit] = useState(true);

  // 一時停止・巻き戻し(L7)。受け取ったフレームを直近 30 秒ぶん持ち、ライブでない間はそこから描く
  const [, setTick] = useState(0);
  const [rewind] = useState(() => new LiveRewind(() => setTick((n) => n + 1)));
  useEffect(() => {
    rewind.setCanvas(canvas.current);
    return () => rewind.close();
  }, [rewind]);
  const rw = rewind.state();

  // 録画(L7、ADR 0015): 録画を始めたタブが、表示のために復号したフレームを、表示した時刻を付けてサーバへ
  // 送り返す。巻き戻し中なら巻き戻した映像が録れる(ウィンドウに描いているものを録る)
  const recHere = useRef<{ last: number } | null>(null);
  /** このタブで始めた録画を止める(映像の作り直しやアプリの終了のとき。下で中身を入れる) */
  const stopRecordRef = useRef<() => void>(() => {});
  const recordChunk = (c: Chunk) => {
    const r = recHere.current;
    const ws = socket.current;
    if (!r || ws?.readyState !== WebSocket.OPEN) return;
    // 表示した時刻。シークで追いつくために続けて復号したフレームは 1 ms ずつにして、録画では見えないようにする
    const ts = Math.max(r.last + 1000, Math.round((performance.timeOrigin + performance.now()) * 1000));
    r.last = ts;
    const out = new Uint8Array(9 + c.data.byteLength);
    const view = new DataView(out.buffer);
    view.setUint8(0, c.key ? 1 : 0);
    view.setBigUint64(1, BigInt(ts));
    out.set(c.data, 9);
    ws.send(out);
  };
  useEffect(() => {
    rewind.setFeedListener(recordChunk);
  });
  const onRewindRef = useRef(onRewind);
  useEffect(() => {
    onRewindRef.current = onRewind;
  });
  // ライブでない間は、バーの位置を進めるために描き直す
  useEffect(() => {
    win.current?.setAttribute('data-paused', String(rw.mode === 'paused'));
    win.current?.setAttribute('data-rewind', rw.mode);
    onRewindRef.current(rw.mode !== 'live');
    if (rw.mode === 'live') return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [rw.mode]);

  useEffect(() => {
    if (live.ended) return;
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    let decoded = 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        // 一時停止・巻き戻し中は、ライブの映像を描かない
        if (!rewind.isLive()) return frame.close();
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
    // 精度モード(L3)の窓は H.264 ではなく PNG が届く。色の変換をせずに描き、画素をそのまま出す
    let png = false;
    let shown = 0;
    let latest = 0;
    const drawPng = (data: Uint8Array<ArrayBuffer>) => {
      const n = ++latest;
      void createImageBitmap(new Blob([data], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        .then((bmp) => {
          // 後から届いたものが先に描けていたら、古いものは描かない
          if (n < shown) return bmp.close();
          shown = n;
          if (el.width !== bmp.width || el.height !== bmp.height) {
            el.width = bmp.width;
            el.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          decoded += 1;
          win.current?.setAttribute('data-decoded', String(decoded));
        })
        .catch((e: unknown) => setError(String(e)));
    };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live/${live.id}`);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    ws.onmessage = (m) => {
      if (typeof m.data === 'string') {
        const c = JSON.parse(m.data) as LiveConfig;
        setConfig(c);
        png = c.codec === 'png';
        if (png) return;
        // 映像が作り直された(大きさが変わったなど)ら、録画はそこで終える(途中で解像度が変わる MP4 は扱いにくい)
        if (recHere.current) stopRecordRef.current();
        const cfg = { codec: c.codec, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true };
        decoder.configure(cfg);
        rewind.configure(cfg);
        return;
      }
      const buf = m.data as ArrayBuffer;
      if (png) return drawPng(new Uint8Array(buf, 9));
      if (decoder.state !== 'configured') return;
      const view = new DataView(buf);
      const key = (view.getUint8(0) & 1) === 1;
      const timestamp = Number(view.getBigUint64(1));
      const data = new Uint8Array(buf, 9);
      // ライブでない間は持っておくだけ。戻ったら次のキーフレームから描く
      if (!rewind.push({ key, ts: timestamp, data })) {
        waitKey = true;
        return;
      }
      if (!key && (waitKey || decoder.decodeQueueSize > MAX_QUEUE)) {
        waitKey = true;
        return;
      }
      waitKey = false;
      recordChunk({ key, ts: timestamp, data });
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
    };
    return () => {
      ws.close();
      socket.current = null;
      if (decoder.state !== 'closed') decoder.close();
    };
  }, [live.id, live.ended, rewind]);

  // 録画(L7)。録画中かはサーバが一覧で知らせる(ほかのタブで始めたものも出る)
  const recording = live.recording && !live.ended;
  useEffect(() => {
    win.current?.setAttribute('data-recording', String(recording));
    // 録画中は枠を赤くする
    win.current?.classList.toggle('recording', recording);
    win.current?.setAttribute('data-exact', String(live.exact));
  }, [recording, live.exact]);
  const fail = (e: unknown) => onMessage(e instanceof Error ? e.message : String(e));
  const stopRecord = () => {
    recHere.current = null;
    api
      .record(live.id, false)
      .then((r) => r.path && onMessage(ja.recordSaved(r.path)))
      .catch(fail);
  };
  const toggleRecord = () => {
    if (live.exact) return onMessage(ja.exactNoRecord);
    // 録画中なら(ほかのタブで始めたものも)止める
    if (live.recording) return stopRecord();
    if (live.ended) return;
    api
      .record(live.id, true)
      .then(() => {
        recHere.current = { last: 0 };
        // 今の表示を作るのに要るフレーム(直前のキーフレームから)を先に送る
        for (const c of rewind.buffer.framesFor(rewind.state().pos)) recordChunk(c);
      })
      .catch(fail);
  };
  const recordRef = useRef(toggleRecord);
  useEffect(() => {
    recordRef.current = toggleRecord;
    stopRecordRef.current = stopRecord;
  });
  // アプリが終わったら、このタブで始めた録画も終える。ほかのタブで止められたら送るのをやめる
  useEffect(() => {
    if (!recHere.current) return;
    if (live.ended) stopRecordRef.current();
    else if (!live.recording) recHere.current = null;
  }, [live.ended, live.recording]);

  // 入力モード: キーはキャンバスが受け取って sendKey で送る(複数のウィンドウへ同時に送るため)。マウスはこのウィンドウで送る
  useEffect(() => {
    const el = win.current;
    el?.setAttribute('data-input', String(inputMode));
    el?.classList.toggle('input-mode', inputMode);
  }, [inputMode]);

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

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void win.current?.requestFullscreen();
  };

  // 再生のキーは、直近 30 秒の一時停止・巻き戻しに効く(L7)
  useImperativeHandle(apiRef, (): LiveApi => ({
    // w r: アプリのウィンドウを表示領域の大きさにする。画素はディスプレイの画素(CSS px × 表示倍率)で数え、等倍で映るようにする(7.9)
    fitApp: () => {
      const r = body.current!.getBoundingClientRect();
      send({ type: 'resize', width: Math.round(r.width * devicePixelRatio), height: Math.round(r.height * devicePixelRatio) });
    },
    // 閉じるボタンなど: デスクトップの × と同じく、アプリに閉じるよう頼む(止めるかはアプリが決める。7.9)
    closeApp: () => send({ type: 'close' }),
    toggleRecord: () => recordRef.current(),
    sendText: (text) => {
      for (const ch of text) {
        send({ type: 'key', key: ch, down: true });
        send({ type: 'key', key: ch, down: false });
      }
    },
    toggle: () => rewind.toggle(),
    isPaused: () => rewind.isPaused(),
    video: () => null,
    setPlaying: (playing) => (playing ? rewind.play() : rewind.pause()),
    seekBy: (sec) => rewind.seekBy(sec),
    step: (dir) => rewind.step(dir),
    seekFraction: (f) => rewind.seekFraction(f),
    speed: () => {},
    ab: () => {},
    toggleMute: () => setMuted((m) => !m),
    toggleZoom: () => setFit((f) => !f),
    goLive: () => rewind.goLive(),
    sendKey: (key, down) => send({ type: 'key', key, down }),
    tapKey: (key) => send({ type: 'tap', key }),
    release: () => send({ type: 'release' }),
    fullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void win.current?.requestFullscreen();
    },
  }), [rewind]);

  const recordButton = !live.ended && !live.exact && (
    <button
      type="button"
      className={`icon-button small${recording ? ' record-on' : ''}`}
      title={recording ? ja.recordStop : ja.record}
      aria-label={recording ? ja.recordStop : ja.record}
      aria-pressed={recording}
      onClick={toggleRecord}
    >
      <Icon name={recording ? 'stopRecord' : 'record'} size={18} />
    </button>
  );
  // 幅の狭い画面はキーボードがない前提なので、入力モードは出さない(見るだけ。18.2)
  const compact = useCompact();
  const inputButton = !live.ended && !compact && (
    <button
      type="button"
      className={`icon-button small${inputMode ? ' input-on' : ''}`}
      title={inputMode ? ja.inputModeExit : ja.inputModeEnter}
      aria-label={inputMode ? ja.inputModeExit : ja.inputModeEnter}
      aria-pressed={inputMode}
      onClick={onToggleInput}
    >
      <Icon name="keyboard" size={18} />
    </button>
  );

  return (
    <WindowFrame
      {...p}
      testId="live-window"
      name={live.title || ja.liveUntitled}
      icon="canvas"
      sectionRef={win}
      titleButtons={
        <>
          {recordButton}
          {inputButton}
        </>
      }
    >
      <div ref={body} className={`window-body ${fit ? 'fit' : 'actual'}`} {...mouse}>
        <canvas
          ref={canvas}
          width={live.width}
          height={live.height}
          // 等倍: Windows の表示倍率を打ち消して、ディスプレイの1画素に合わせる(7.9)
          style={fit || !config ? undefined : { width: config.width / devicePixelRatio, height: config.height / devicePixelRatio }}
        />
        {live.ended && <div className="window-overlay ended">{ja.liveEnded}</div>}
        {error && (
          <div className="window-overlay error" role="alert">
            {error}
          </div>
        )}
      </div>
      <LiveControls
        mode={rw.mode}
        start={rw.start}
        end={rw.end}
        pos={rw.pos}
        rewindable={!live.exact}
        info={
          <>
            {rw.mode === 'live' && <span className={`live-badge${live.ended ? ' ended' : ''}`}>{live.ended ? ja.liveEnded : ja.live}</span>}
            {live.exact && (
              <span className="exact-badge" title={ja.exactHint}>
                {ja.exactMode}
              </span>
            )}
            {recording && <span className="recording-badge">{ja.recording}</span>}
            {config && (
              <span className="muted">
                {config.width}×{config.height}
              </span>
            )}
            {/* 映像に重ねると、その下をアプリで選べなくなるので、下のバーに出す */}
            {inputMode && (
              <span className="input-hint" title={ja.inputModeHint}>
                {ja.inputModeHint}
              </span>
            )}
          </>
        }
        muted={muted}
        volume={volume}
        fit={fit}
        onToggle={() => rewind.toggle()}
        onSeek={(ts) => rewind.seekTo(ts)}
        onSeekBy={(sec) => rewind.seekBy(sec)}
        onStep={(dir) => rewind.step(dir)}
        onLive={() => rewind.goLive()}
        onMute={() => setMuted((m) => !m)}
        onVolume={(v) => {
          setVolume(v);
          setMuted(v === 0);
        }}
        onZoom={() => setFit((f) => !f)}
        onFullscreen={fullscreen}
      />
    </WindowFrame>
  );
}
