# 0014: NVENC は実際に1枚エンコードして使えるかを確かめてから使う

- 日付: 2026-10-18
- フェーズ: 4
- 状態: 採用

仕様(3.4、7.3)では、ライブ映像のエンコードは NVENC があれば使い、なければ libx264 にする。ffmpeg の `-encoders` に h264_nvenc が出ても、GPU やドライバ(libcuda)がなければ使えない(開発用コンテナの ffmpeg がそうで、`Cannot load libcuda.so.1` で失敗する)。そこで、ライブ描画のセッションを作るときに一度だけ、`ffmpeg -f lavfi -i color=…` の 256×256 の画像1枚を h264_nvenc でエンコードしてみて、成功したら NVENC、失敗したら libx264 を使う(`crates/capture/src/encoder.rs`)。ドライバの初期化で固まる場合に備え、10 秒で打ち切って libx264 にする。`/dev/nvidia0` や `nvidia-smi` の有無で決める案は、コンテナに GPU を渡していても ffmpeg 側が対応していない場合などを見分けられないので採らなかった。NVENC の設定は `-preset p1 -tune ull -zerolatency 1`(最速・超低遅延)で、B フレームなし・キーフレームの間隔は libx264 と同じにする。`DEW_ENCODER=libx264` か `nvenc` で決め打ちにもできる。どちらを使っているかは `dew doctor` とサーバのログに出す。受け入れ基準の「NVENC のある環境では自動で使われ、ない環境では libx264 に切り替わる」は、偽の ffmpeg(終了コードだけ返すもの)で選び方を確かめる単体テストと、本物の ffmpeg で GPU のない環境では libx264 になるテストで確かめる。GPU のある環境での実際の映りは、人が `dew doctor` で確かめる。
