// キャンバス: ファイル再生のウィンドウを並べる(4.2)。S9 で作り込む
import { basename } from '../format';
import { api } from '../api/http';

export type Win = { id: number; path: string };

type Props = {
  active: boolean;
  windows: Win[];
  focused: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  onHome: () => void;
  onError: (m: string) => void;
};

export function Canvas(p: Props) {
  return (
    <div className="canvas">
      {p.windows.map((w) => (
        <section key={w.id} data-testid="player-window" onClick={() => p.onFocus(w.id)}>
          <header>{basename(w.path)}</header>
          <video src={api.mediaUrl(w.path)} autoPlay />
        </section>
      ))}
    </div>
  );
}
