// 操作モード(5.1)のウィンドウとキャンバスのやり取り。キーはキャンバスが受け取り、操作モードのウィンドウ
// (選択中の同じ種類のウィンドウなら全部)に配る。複数のときは、先頭(フォーカス中)のウィンドウだけが
// 小さな画面や検索欄を出し、決めた内容を share でほかのウィンドウにも渡す(ADR 0030)
import type { KeyInfo } from '../keys';

export type OpContext = {
  /** フォーカス中のウィンドウか(小さな画面・検索欄・コピーなど、1つで行う操作はこのウィンドウだけ) */
  lead: boolean;
  /** このウィンドウでは操作できなかった(列がない、型が合わないなど。キャンバスがまとめて知らせる) */
  fail: () => void;
};

/** リンクヒントを、操作モードの全ウィンドウのリンクにまとめて割り当てる(17.4) */
export type HintMode = 'open' | 'window' | 'copy';
export type OpHints = {
  /** 見えているリンクを数える(続けて show に同じ数の文字を渡す) */
  targets(): number;
  show(mode: HintMode, labels: string[]): void;
  /** 打った文字(先頭が一致するヒントだけを出す) */
  type(typed: string): void;
  pick(label: string): void;
  clear(): void;
};

export type OpWindow = {
  /** 操作モードのキー。使ったら true(使わなかった Esc・Ctrl+[・q で、キャンバスが操作モードを抜ける) */
  key(k: KeyInfo, ctx: OpContext): boolean;
  /** 先頭のウィンドウで決めた操作を受け取る。適用できなければ false */
  share?(m: unknown): boolean;
  hints?: OpHints;
};
