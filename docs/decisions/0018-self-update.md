# 0018: dew update は GitHub の Releases から取り、非公開なら gh を使う

- 日付: 2026-10-18
- フェーズ: 配布
- 状態: 採用

仕様 3.1・7.10 の `dew update` は、GitHub の Releases の最新の版(`DEW_UPDATE_REPO`、既定は kWat0M/DevView)を見て、今の版(`CARGO_PKG_VERSION`)より新しければ配布物(`scripts/release.sh` が作る `…-x86_64-linux.tar.gz`)を取り、同梱の `SHA256SUMS` で確かめてから、今の実行ファイルと同じディレクトリに書いて rename で置き換える(途中で失敗しても壊れた dew が残らない)。まず認証なしで GitHub の API(`/repos/{repo}/releases/latest`)を見る。公開リポジトリ(仕様の「バイナリだけを置く公開リポジトリ」)ならこれで取れる。見つからない(404。非公開か、リリースがない)ときは、ログイン済みの `gh` があれば `gh release view` / `gh release download` で取る(仕様の「自分用は非公開 Releases + gh」)。どちらも使えなければ何もせず、作者から tar.gz を受け取って手で置き換える方法を出す(仕様の「どちらにも届かない環境では手動更新の方法を表示する」)。展開と確かめには、システムの `tar` と `sha256sum` を使い、新しいクレートは足さない(HTTP は CLI がすでに持っている reqwest と rustls を使い、証明書は OS のものを使う)。更新元の切り替えは、仕様では設定ファイルだが、設定ファイル自体が未実装(9.2)なので、当面は環境変数にした。動いているサーバは入れ替わらないので、更新後に `dew stop` してから起動し直すよう案内する。テストは、python の http.server で偽のリリースを配り(`DEW_UPDATE_API` で向け先を変える)、入れ替わること・最新なら何もしないこと・チェックサムが合わなければ入れ替えないことを確かめる。
