// CSV のドキュメントウィンドウ(15章、16章)。表の描画と TanStack Table / Virtual は別のチャンク(CsvView)で、
// 最初に CSV を開いたときに読み込む(15.6)
import { lazy, Suspense, useEffect, useRef } from 'react';
import type { Events } from '../api/events';
import { WindowFrame, type FrameProps } from '../canvas/WindowFrame';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import { Icon } from '../icons';
import type { CsvAction } from './keys';

const CsvView = lazy(() => import('./CsvView'));

type Props = FrameProps & {
  id: number;
  path: string;
  events: Events;
  inputMode: boolean;
  onToggleInput: () => void;
  onEnterInput: () => void;
  onExitInput: () => void;
  onMessage: (m: string) => void;
  onRegister: (run: ((a: CsvAction) => void) | null) => void;
};

export function CsvWindow({ id, path, events, inputMode, onToggleInput, onEnterInput, onExitInput, onMessage, onRegister, ...frame }: Props) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = section.current;
    el?.setAttribute('data-input', String(inputMode));
    el?.classList.toggle('input-mode', inputMode);
  }, [inputMode]);
  return (
    <WindowFrame
      {...frame}
      testId="csv-window"
      name={basename(path)}
      icon="table"
      sectionRef={section}
      titleButtons={
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
      }
    >
      <div className="csv">
        <Suspense fallback={<div className="doc-message">{ja.loading}</div>}>
          <CsvView id={id} path={path} events={events} inputMode={inputMode} onExitInput={onExitInput} onEnterInput={onEnterInput} onMessage={onMessage} onRegister={onRegister} />
        </Suspense>
      </div>
    </WindowFrame>
  );
}
