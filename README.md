# My Digital Laboratory

GitHub Pages で公開している、制作物・実験用ページの置き場です。ビルド不要の静的 HTML のみで構成されています。

## ページ一覧

| ファイル | 内容 |
|---|---|
| [`index.html`](index.html) | トップページ（各ページへのリンク集） |
| [`page_opencvjs_demo.html`](page_opencvjs_demo.html) | OpenCV.js によるカメラ映像のリアルタイム画像処理（オリジナル / カートゥーン / グレースケール / 2値化 / Canny エッジ抽出） |
| [`page_text_processer.html`](page_text_processer.html) | テキスト加工ツール（文字数・行数カウント、連番付与、行ソート、置換、行頭・行末への付与、改行⇔文字列変換） |
| `opencv.js` | OpenCV.js 本体（CDN ではなく同梱して読み込み） |

## ローカルでの確認

カメラ（`getUserMedia`）は `file://` では動作しないため、簡易サーバー経由で開いてください。

```sh
python3 -m http.server 8000
# → http://localhost:8000/ を開く
```

## ページの追加方法

1. `page_xxx.html` を作成する（先頭に `<a href="index.html">← トップへ戻る</a>` を置く）
2. `index.html` の `<ul class="menu-list">` に `<li class="menu-item">` を追加する
