# 0003: TLS の暗号実装は ring に統一する

- 日付: 2026-10-15
- フェーズ: 1
- 状態: 採用

rustls・axum-server・reqwest・rcgen の暗号実装は、すべて ring に統一する。rustls 系の多くは既定で aws-lc-rs を使うが、aws-lc-sys は cmake と C コンパイラで大きな C ライブラリをビルドするため、ビルドが遅く、musl での静的リンク(9.1 の既定)で問題が出やすい。ring も C とアセンブリを含むが、musl-gcc で静的リンクできる実績が多く、rcgen の既定も ring である。各クレートは `*-no-provider` か `default-features = false` で ring を選び、起動時に `rustls::crypto::ring::default_provider().install_default()` を呼ぶ。FIPS 対応などで aws-lc が必要になったら見直す。
