# My Digital Laboratory

GitHub Pages で公開している、制作物・実験用ページの置き場です。ビルド不要の静的 HTML のみで構成されています。

## ページ一覧

| ファイル | 内容 |
|---|---|
| [`index.html`](index.html) | トップページ（各ページへのリンク集） |
| [`page_opencvjs_demo.html`](page_opencvjs_demo.html) | OpenCV.js によるカメラ映像のリアルタイム画像処理（オリジナル / カートゥーン / グレースケール / 2値化 / Canny エッジ抽出） |
| [`page_text_processer.html`](page_text_processer.html) | テキスト加工ツール（文字数・行数カウント、連番付与、行ソート、置換、行頭・行末への付与、改行⇔文字列変換） |
| [`page_sensor_viewer.html`](page_sensor_viewer.html) | スマホのセンサー情報ビューア（傾き・方位・加速度・ジャイロ・位置情報・マイク音量・タッチ・端末情報・バイブ） |
| `opencv.js` | OpenCV.js 本体（CDN ではなく同梱して読み込み） |

## ローカルでの確認

カメラ・マイク・センサーは `file://` や HTTP では動作しない場合があるため、簡易サーバー経由で開いてください。

```sh
python3 -m http.server 8000
# → http://localhost:8000/ を開く
```

## ページの追加方法

1. `page_xxx.html` を作成する（先頭に `<a href="index.html">← トップへ戻る</a>` を置く）
2. `index.html` の `<ul class="menu-list">` に `<li class="menu-item">` を追加する

## センサー情報ビューアの注意点

- iPhone では「センサーを開始」をタップしたときに傾き・加速度の許可ダイアログが出ます。
- 位置情報・マイクはカードごとのボタンで開始します（それぞれ許可が必要）。
- バッテリー・通信情報・バイブ・絶対方位は主に Android の Chrome で利用できます。
- 実機で試すときは GitHub Pages（HTTPS）の URL を開いてください。
