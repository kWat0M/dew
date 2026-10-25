// キー判定(5.6)。KeyboardEvent.key を基本にし、日本語 IME が有効なとき(key が Process)だけ
// 英字・数字を code から求める。Ctrl 系はキーマップに使わない(モードや入力を抜ける Ctrl+[ だけ例外。vim の Esc の代わり)

/** キーマップで使うキーの名前。`C-[` 以外は KeyboardEvent.key と同じ(例: 'j', 'J', 'Enter', ' ') */
export type Key = string;

export type KeyInfo = {
  key: Key;
  /** IME が有効なまま押された(画面に「IME オン」を出す) */
  ime: boolean;
};

const imeLetter = /^Key([A-Z])$/;
const imeDigit = /^Digit([0-9])$/;

/** キーマップに渡すキーにする。無視するキー(変換中、修飾キーだけ、Ctrl 系)は null */
export function readKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): KeyInfo | null {
  if (e.isComposing) return null;
  // 物理キーの位置(code)では判定しない(JIS 配列では US の ] の位置に [ がある)
  if (e.ctrlKey && !e.altKey && !e.metaKey) return e.key === '[' ? { key: 'C-[', ime: false } : null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Process') {
    const letter = imeLetter.exec(e.code)?.[1];
    if (letter) return { key: e.shiftKey ? letter : letter.toLowerCase(), ime: true };
    const digit = imeDigit.exec(e.code)?.[1];
    if (digit && !e.shiftKey) return { key: digit, ime: true };
    return null;
  }
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null;
  return { key: e.key, ime: false };
}

/** モードや入力を抜けるキー(Esc・Ctrl+[・q)。文字を打つ欄では q は文字なので除く */
export function isLeaveKey(key: Key, typing = false): boolean {
  return key === 'Escape' || key === 'C-[' || (!typing && key === 'q');
}

/** 文字を打つ欄から抜けるキーか(Esc・Ctrl+[。変換中は除く) */
export function leavesInput(e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): boolean {
  const k = readKey(e);
  return k !== null && isLeaveKey(k.key, true);
}

/**
 * 複数打鍵(gg、w に続く1打鍵など)を含むキーマップ。押されたキーを順に渡すと、
 * 確定した操作を返す。途中なら 'pending'、どれにも当たらなければ null
 */
export class KeySequence<A> {
  private buffer: Key[] = [];
  private readonly map: Map<string, A>;
  private readonly prefixes: Set<string>;

  constructor(bindings: Record<string, A>) {
    this.map = new Map(Object.entries(bindings));
    this.prefixes = new Set();
    for (const seq of this.map.keys()) {
      const keys = split(seq);
      for (let i = 1; i < keys.length; i++) this.prefixes.add(keys.slice(0, i).join(' '));
    }
  }

  /** 途中まで押したキー(which-key 風の候補表示に使う) */
  get pending(): readonly Key[] {
    return this.buffer;
  }

  /** 途中のキーに続けられる候補 */
  candidates(): [Key, A][] {
    const head = this.buffer.join(' ');
    return [...this.map].filter(([seq]) => seq.startsWith(head + ' ')).map(([seq, a]) => [split(seq).at(-1)!, a]);
  }

  push(key: Key): A | 'pending' | null {
    this.buffer.push(key);
    const seq = this.buffer.join(' ');
    const action = this.map.get(seq);
    if (action !== undefined) {
      this.buffer = [];
      return action;
    }
    if (this.prefixes.has(seq)) return 'pending';
    this.buffer = [];
    return null;
  }

  reset() {
    this.buffer = [];
  }
}

/** 複数打鍵は 'g g' や 'w 1' のように空白で区切って書く(Space キー自体は ' ') */
function split(seq: string): Key[] {
  return seq === ' ' ? [seq] : seq.split(' ');
}
