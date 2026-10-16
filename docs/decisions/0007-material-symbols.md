# 0007: アイコンは Material Symbols の SVG パッケージを使う

- 日付: 2026-10-16
- フェーズ: 1
- 状態: 採用

アイコンは、Material Icons のパスデータを手で書き写す方法をやめ、Google の Material Symbols(Rounded、太さ 400)の SVG を npm パッケージ `@material-symbols/svg-400`(Apache-2.0、Google のリポジトリから個人がまとめて公開しているもの)から読み込む。手で写す方法では、5秒・30秒送りのような Material Icons にない形を自作するしかなく、数字と矢印がずれた。Material Symbols には replay_5 / forward_30 などがそろっている。SVG は Vite の `?raw` で文字列として取り込み、使うものだけがビルドに入るので、配布バイナリはほとんど大きくならない。アイコンフォントは、外部からの読み込みが要るうえ全字形が入って重いため使わない。
