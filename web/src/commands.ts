// 操作の一覧。キー・操作パネルのボタン・ヒントの帯で同じものを使う

/** 1つの操作。key は表示用のキー */
export type Command = { key: string; label: string; run: () => void };
export type Section = { title: string; items: Command[] };

/** 画面が受け付ける操作の定義(id はその画面の操作の値) */
export type CommandDef<A> = { id: A; key: string; label: string };
