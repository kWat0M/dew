// 見た目の設定。ブラウザごとに覚える(localStorage。使えない環境では既定値のまま動く)
import { useEffect, useState } from 'react';

/** テーマ: ブラウザに合わせる / ライト / ダーク(18.1) */
export type Theme = 'system' | 'light' | 'dark';
export const THEMES: Theme[] = ['system', 'light', 'dark'];

export type Settings = {
  /** 画面下のヒントの帯 */
  hints: boolean;
  /** タブバーの形: 上部に横並び / 左端に縦並び(普段は隠す) */
  tabbar: 'top' | 'side';
  /** 同期再生中は全ウィンドウの音を出す(7.6) */
  syncAudio: boolean;
  /** 裏にあるタブに表示指示が届いたら、ブラウザの通知を出す(14.2) */
  notify: boolean;
  /** ファイルを開いた直後は操作モードで始める(15.3 の document_auto_input をすべてのファイルに広げた。ADR 0030) */
  openInOpMode: boolean;
  /** Markdown の外部の画像を、クリックを待たずに読み込む(17.2) */
  externalImages: boolean;
  /** テーマ。ブラウザごとに覚える(端末ごとに好みが違うため。ADR 0031) */
  theme: Theme;
  /** キャンバスの上部のバーを普段は隠し、画面の上端にマウスを寄せたときだけ出す(18.4) */
  autoHideBar: boolean;
};

const DEFAULTS: Settings = { hints: true, tabbar: 'top', syncAudio: false, notify: false, openInOpMode: true, externalImages: false, theme: 'system', autoHideBar: false };
// index.html の最初の描画の前のスクリプトも、この名前でテーマを読む
const KEY = 'dew.settings';

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(load);
  const update = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // 覚えられなくても、このタブの間は効く
      }
      return next;
    });
  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  return [settings, update];
}

/** <html> の data-theme を付け替える。ブラウザに合わせるときは外す */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}
