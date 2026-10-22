# 0027: 開発用コンテナを dotfiles の新しい見本に合わせ、WSLg に依存しない形にする

- 日付: 2026-10-22
- フェーズ: 6 と 7 の間
- 状態: 採用

開発する場所を WSL2 だけでなく Linux サーバ(共用、Docker が使える)のコンテナにも広げるため、開発用コンテナを dotfiles の新しい見本(`docker/rust` と dev-tools イメージ)に合わせて作り直した(spec 10章)。Dockerfile は base → toolchain → development のステージにし、エディタ・lazygit・yazi・Claude Code などは dev-tools イメージから `COPY --from` で取り込む。見本にあるリリースビルド・本番用のステージ(builder / production)と本番用の compose.yaml は、dew は他人のコンテナに入れて使う単体のバイナリで本番用イメージの使い道がないので持たず、`compose/compose.yaml` は見本の compose.dev.yaml にあたる開発用だけにした(配布物は今までどおり `scripts/release.sh`)。WSLg のソケットの共有と mpv・chafa はやめた(dew は自前の Xvfb と pulseaudio を使い、サーバには WSLg がない)。dev-tools には Release 版の dew が入っているので、`target/debug` を PATH の先頭に置き、手で打った `dew` は開発中のものを使う。共有メモリは `ipc: host` をやめて `shm_size: 2gb` にした(コンテナ専用の /dev/shm になり、共用のサーバでホストや他の人のコンテナと混ざらない)。`DEW_PUBLIC_HOST` は compose に直接 `localhost` と書いていたのを `.env` から読むようにし、ポートは `.env` の `DEW_PORT` / `VITE_PORT` で必ず決める。Vite の開発サーバにはトークンがないので、ホストの `127.0.0.1` だけで受け、サーバでは `ssh -L` で開く(dew 本体はトークン付き URL で直結する)。NVENC 用の GPU の指定は今回は足さない。WSLg の PULSE_SERVER がなくなると Firefox の AudioContext が動かず音の E2E が測れないので、E2E の globalSetup でブラウザ専用の null-sink の pulseaudio を立て、PULSE_SERVER をブラウザにだけ渡す(dew には fixture が環境変数を絞って渡す)。
