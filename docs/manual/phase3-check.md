# フェーズ3(ライブ描画)を人が確かめる手順

受け入れ基準は E2E で確かめている。ここでは、自動テストでは分からない見た目・操作感を、WSL の開発用コンテナと Windows のブラウザ(Zen / Chrome)で確かめる。

## 準備(開発用コンテナで)

```bash
cd ~/projects/DevView
pnpm -C web build && cargo build -p dew
alias dew=$PWD/target/debug/dew
dew stop       # 前に起動したサーバが残っていたら止める(dew は動いているサーバを使い回すので、ビルドし直しても古いままになる)
dew            # 出た URL を Windows のブラウザで開き、「クリックかキーで開始」を押す
```

## 確かめること

| # | 操作(コンテナで) | 期待する見た目・操作感 |
|---|---|---|
| 1 | `dew run python3 tests/apps/counter.py &` | キャンバスに「counter」のウィンドウが出て、中央の数字が滑らかに増える。右上のミュートボタンを押すと 440 Hz の音が鳴る |
| 2 | `dew run python3 tests/apps/counter.py --tone 660 --title high &` | ウィンドウが2つになる。片方をクリックすると、そのウィンドウの音(440 Hz か 660 Hz)だけが鳴る |
| 3 | `dew run python3 tests/apps/mpl_sample.py &` を開き、ウィンドウを選んで `i` | 枠の色が変わり「入力モード」と出る。matplotlib のツールバーの移動・拡大がマウスで使える。`Ctrl+]` で抜ける |
| 4 | `dew run python3 tests/apps/counter.py --resizable --title big &` を開き、`w f` で最大化してから `w r` | アプリの画面が表示領域いっぱいの大きさになり、ぼやけない(等倍で映る)。数字は増え続ける |
| 5 | `dew run python3 tests/apps/popup.py --outside &` | 灰色のウィンドウの左上に赤い四角が重なって映る。右下の緑の四角は、灰色の範囲に重なる部分だけ映る(はみ出した部分が映らないのは今の仕様。ADR 0012) |
| 6 | `dew run python3 tests/apps/cv2_sample.py &` | OpenCV の窓が出る |
| 7 | アプリを終わらせる(`kill %1` など) | ウィンドウに最後の画面が残り、「終了」と出る。`w x` で閉じられる |

気になった点(遅い、カクつく、音が途切れる、操作が分かりにくい など)は、どの手順で起きたかと一緒に伝える。終わったら `dew stop`。
