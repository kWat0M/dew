// ライブウィンドウの下部(4.2): 動画のウィンドウのコントロールと同じ並び。ライブ中はすっきりさせ、中央の
// 一時停止ボタンと、右の音量・等倍・全画面だけを出す。一時停止(巻き戻し)に入ると、動画と同じシークバーと
// 送り・戻しのボタン、「ライブへ戻る」を出す(L7、ADR 0016)
import type { ReactNode } from 'react';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import { IconButton, SeekButton } from './Controls';
import { SeekBar } from './SeekBar';

type Props = {
  /** live: ライブ表示中、paused / playing: 巻き戻し中 */
  mode: 'live' | 'paused' | 'playing';
  /** 持っている範囲と表示中の位置(マイクロ秒) */
  start: number;
  end: number;
  pos: number;
  /** 一時停止・巻き戻しができるか(精度モードの窓はできない) */
  rewindable: boolean;
  /** 左に出すもの(ライブの印、大きさ、入力モードの表示など) */
  info: ReactNode;
  muted: boolean;
  volume: number;
  fit: boolean;
  onToggle: () => void;
  onSeek: (ts: number) => void;
  onSeekBy: (sec: number) => void;
  onStep: (dir: 1 | -1) => void;
  onLive: () => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onZoom: () => void;
  onFullscreen: () => void;
};

export function LiveControls(p: Props) {
  const rewinding = p.mode !== 'live';
  const duration = Math.max(0, (p.end - p.start) / 1e6);
  return (
    <footer className="controls live-bar">
      {rewinding && (
        <SeekBar
          path=""
          time={(p.pos - p.start) / 1e6}
          duration={duration}
          sprite={null}
          ranges={[]}
          ab={{ a: null, b: null }}
          onSeek={(t) => p.onSeek(p.start + t * 1e6)}
        />
      )}
      <div className="control-row">
        <div className="control-side">
          {rewinding && <span className="time">{ja.behind((p.end - p.pos) / 1e6)}</span>}
          {p.info}
        </div>
        <div className="transport">
          {rewinding && p.mode === 'paused' && <IconButton icon="frameBack" label={ja.frameBack} title={ja.frameBackKey} onClick={() => p.onStep(-1)} />}
          {rewinding && <SeekButton sec={5} back label={ja.back5} onClick={() => p.onSeekBy(-5)} />}
          {rewinding && <SeekButton sec={30} back label={ja.back30} onClick={() => p.onSeekBy(-30)} />}
          {p.rewindable && (
            <button
              type="button"
              className="play-button"
              aria-label={p.mode === 'paused' ? ja.playLabel : ja.pauseLabel}
              title={p.mode === 'paused' ? ja.play : ja.pause}
              onClick={p.onToggle}
            >
              <Icon name={p.mode === 'paused' ? 'playCircle' : 'pauseCircle'} size={44} />
            </button>
          )}
          {rewinding && <SeekButton sec={30} label={ja.fwd30} onClick={() => p.onSeekBy(30)} />}
          {rewinding && <SeekButton sec={5} label={ja.fwd5} onClick={() => p.onSeekBy(5)} />}
          {rewinding && p.mode === 'paused' && <IconButton icon="frameNext" label={ja.frameNext} title={ja.frameNextKey} onClick={() => p.onStep(1)} />}
        </div>
        <div className="control-side end">
          {rewinding && (
            <button type="button" className="text-button" title={ja.backToLiveKey} onClick={p.onLive}>
              {ja.backToLive}
            </button>
          )}
          <button type="button" className="icon-button small" title={ja.mute} aria-label={ja.mute} aria-pressed={p.muted} onClick={p.onMute}>
            <Icon name={p.muted || p.volume === 0 ? 'volumeOff' : 'volume'} size={20} />
          </button>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={p.muted ? 0 : p.volume}
            aria-label={ja.volume}
            onChange={(e) => p.onVolume(Number(e.target.value))}
          />
          <button type="button" className="text-button" title={ja.zoom} onClick={p.onZoom}>
            {p.fit ? ja.zoomFit : ja.zoomActual}
          </button>
          <button type="button" className="icon-button small" title={ja.fullscreen} aria-label={ja.fullscreen} onClick={p.onFullscreen}>
            <Icon name="fullscreen" size={20} />
          </button>
        </div>
      </div>
    </footer>
  );
}
