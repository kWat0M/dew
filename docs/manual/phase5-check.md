# フェーズ5の確認(人が見る・操作する部分)

自動テストでは、端末に書き込むシーケンスまでと、ブラウザの表示を確かめている。ここでは、実際の端末とブラウザでの動きを見る。

## 1. dew activate(bash と zsh)

```bash
dew setup-shell          # y で ~/.bashrc(zsh なら ~/.zshrc)に1行足す。2回目は「追記済み」と出る
exec $SHELL              # シェルを開き直す
dew activate             # 「有効にしました(ディスプレイ :100)」。プロンプトに (dew) が付く(starship では付かない)
python3 tests/apps/counter.py   # dew run なしでブラウザのキャンバスに出る
dew status               # 「activate 中のシェル: 1」
dew stop                 # 確認が出る。Enter で止めない
dew deactivate           # 「元に戻しました」。echo $DISPLAY $WAYLAND_DISPLAY が activate 前の値
```

starship を使っている場合は、`dew shell-init --help` の設定例を `~/.config/starship.toml` に足すと、activate 中に `dew` と出る。

## 2. タブを開いたままにする

1. ブラウザで dew を開き、タブを固定する
2. 端末で `dew stop`(確認が出たら y)→ タブの上に「サーバ停止中。再接続を試みています」
3. `dew` で起動し直す → 5秒ほどで表示が消える(ページは読み直さず、キャンバスのウィンドウはそのまま)
4. `dew <ファイル>` → そのタブに出る

## 3. タブがないとき(WezTerm)

ふだんの `wezterm.lua` は変えずに、テスト用の設定で別のウィンドウを開いて試す。

1. Windows 側に `dew-test.lua` を作る。中身は、ふだんの設定を読み込んで `dew setup-wezterm` のハンドラを足すだけ:

   ```lua
   local wezterm = require 'wezterm'
   local config = dofile(wezterm.config_dir .. '/wezterm.lua')  -- ふだんの設定(場所は環境に合わせる)
   -- ここに dew setup-wezterm が出す wezterm.on('user-var-changed', ...) を貼る
   return config
   ```

2. `wezterm.exe --config-file <dew-test.lua の場所> start` で別のウィンドウを開き、その中でコンテナに入る
3. dew のタブをすべて閉じてから `dew <ファイル>` → Windows の既定のブラウザが開き、そのファイルが出る。端末の通知(「ブラウザで開きます」)も出る
4. `dew url --open` → Home が開く
5. tmux の中でも試す: `~/.tmux.conf` に `set -g allow-passthrough on` がないと開かない(`dew doctor` で案内が出る)
6. ウィンドウを閉じれば、テスト用の設定は何も残らない

WezTerm を使わない端末では、`dew <ファイル>` が出す URL を2分以内に開くか、Home の URL を開けばそのファイルが出る。

## 4. 裏にあるタブへの知らせ

1. dew のタブを開いたまま、ほかのタブを前に出す
2. `dew <ファイル>` → dew のタブのタイトルが「● dew」になる。dew のタブを表に出すと消える
3. 操作パネルの「裏にあるときに開く指示が来たら通知する」をオンにすると、通知の許可を求められる。許可すると、2. で通知が出て、クリックするとタブが表に出る。自己署名証明書の接続ではブラウザが通知を拒むことが多く、そのときは項目が押せない(「この接続ではブラウザの通知を使えません」)
