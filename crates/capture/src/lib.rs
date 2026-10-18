//! ライブ描画(フェーズ3): 仮想ディスプレイ(Xvfb)と音声サーバ(pulseaudio)、ウィンドウの取り込み、入力の注入

pub mod audio;
pub mod encoder;
pub mod input;
pub mod monitor;
pub mod pulse;
pub mod record;
pub mod session;
pub mod stream;
