// CSV のドキュメントウィンドウ(15章、16章)。表の描画と TanStack Table / Virtual は別のチャンク(CsvView)で、
// 最初に CSV を開いたときに読み込む(15.6)
import { lazy, Suspense } from 'react';
import type { Events } from '../api/events';
import type { OpWindow } from '../canvas/op';
import { WindowFrame, type FrameProps } from '../canvas/WindowFrame';
import { basename } from '../format';
import { ja } from '../i18n/ja';
import type { CsvAction } from './keys';

const CsvView = lazy(() => import('./CsvView'));

type Props = FrameProps & {
  id: number;
  path: string;
  events: Events;
  onMessage: (m: string) => void;
  onRegister: (run: ((a: CsvAction) => void) | null) => void;
  onOp: (w: OpWindow | null) => void;
  onShare: (m: unknown) => void;
};

export function CsvWindow({ id, path, events, onMessage, onRegister, onOp, onShare, ...frame }: Props) {
  return (
    <WindowFrame {...frame} testId="csv-window" name={basename(path)} icon="table">
      <div className="csv">
        <Suspense fallback={<div className="doc-message">{ja.loading}</div>}>
          <CsvView id={id} path={path} events={events} opMode={frame.opMode} onMessage={onMessage} onRegister={onRegister} onOp={onOp} onShare={onShare} />
        </Suspense>
      </div>
    </WindowFrame>
  );
}
