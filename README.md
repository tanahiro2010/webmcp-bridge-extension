# webmcp-bridge-extension

Chrome (MV3) 拡張機能。[webmcp-bridge-mcp](../webmcp-bridge-mcp) の WebSocket サーバーへ接続し、
現在開いているページから WebMCP tool を検出、右上のオーバーレイからインストール、MCP サーバー経由の
tool 実行リクエストをページ上で実行します。

**MCP サーバーを先に起動しておく必要があります**（`webmcp-bridge-mcp` で `bun run dev`）。
拡張機能は `ws://127.0.0.1:8787` に接続を試み、繋がらない場合は3秒ごとに再接続を試みます。

## インストール

```bash
bun install
```

## 開発起動

```bash
bun run dev
```

`src/` `manifest.json` `examples/` の変更を検知して `dist/` に再ビルドします（ホットリロードはありません。
再ビルド後は `chrome://extensions` で拡張機能を再読み込みしてください）。

## ビルド

```bash
bun run build
```

`dist/` に読み込み可能な拡張機能一式が出力されます。

## Chromeへの読み込み方法

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON にする
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. このプロジェクトの `dist/` ディレクトリを選択

拡張機能の Service Worker のログは `chrome://extensions` の当該拡張機能の「Service Worker」リンクから
DevTools を開くと確認できます（WebSocket の送受信、tab 追跡、ルーティングの様子がすべて `console.log` で見えます）。
同様に `content.ts` / `injected.ts` のログはページの DevTools コンソールに `[webmcp:content]` /
`[webmcp:injected]` プレフィックス付きで出力されます。

> 通常の Chrome（正規ビルド）は Chrome 137 以降 `--load-extension` コマンドラインフラグを廃止しているため、
> `chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」ボタン以外の方法（自動化スクリプト
> など）で読み込みたい場合は [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) や
> Chromium を使ってください。手動で「パッケージ化されていない拡張機能を読み込む」からインストールする分には
> 通常の Chrome で問題ありません。

## WebMCP 検出仕様

この拡張機能は [WebMCP 仕様](https://webmachinelearning.github.io/webmcp/)（W3C Web Machine Learning
Community Group、2026年2月ドラフト）に定義された2つの API をそのまま検出・実行します。

### 1. 命令型 — `document.modelContext.registerTool()`

```js
await document.modelContext.registerTool({
  name: "reserve_hotel",
  description: "Reserve a hotel",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  execute: async ({ city }) => ({ ok: true, city }),
});
```

`document.modelContext` がまだブラウザにネイティブ実装されていない場合、この拡張機能が
`injected.ts`（`manifest.json` で `"world": "MAIN"` 指定の main-world content script）から
最小限の polyfill（`registerTool` / `getTools` / `executeTool` / `toolchange` イベント）を注入します。
ネイティブ実装がある場合は何もしません。

### 2. 宣言型 — annotated `<form>`

```html
<form toolname="search_hotels" tooldescription="Search hotels">
  <input name="city" toolparamdescription="City to search hotels in" required />
  <button type="submit">Search</button>
</form>
```

`toolname` / `tooldescription` を持つ `<form>` を検出すると、`<input>` / `<select>` / `<textarea>` の
`name` 属性・`required` 属性・`toolparamdescription`（無ければ関連する `<label>` のテキスト）から
JSON Schema を合成し、`document.modelContext.registerTool()` で登録します（内部的には命令型と同じ
API に正規化されます）。

実行時はフォームの各フィールドに引数を入力してから：

- `toolautosubmit` 属性がある場合 → 拡張機能が自動で送信します
- 無い場合 → 送信ボタンにフォーカスするだけで止まり、人間が内容を確認して手動送信する必要があります
  （`webmcp_call_tool` はこの場合 `{ pending: true, ... }` を返し、実際の送信は待ちません）

送信結果は仕様通り `SubmitEvent#respondWith()` で受け取ります。ページ側は次のように実装します。

```js
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.agentInvoked) {
    event.respondWith(Promise.resolve({ ok: true /* ... */ }));
  }
});
```

> **注:** フォーム→JSON Schema の変換アルゴリズムは、WebMCP 仕様自体がまだ
> [「TBD」と明記](https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md)
> している部分（`step`/`min`/`max` の扱いなど）があります。この拡張機能の実装は仕様に明記された部分
> （`name`→プロパティ名、`required`→必須項目、`<select>`→`enum`、`toolparamdescription`/`<label>`→
> `description`）に忠実ですが、数値制約などの細部は独自の合理的な解釈です。

検出は初回スキャンに加え、DOM 変化（`MutationObserver`：フォームの追加/削除、`toolname`/`tooldescription`
属性の変更）とタブの再表示（`visibilitychange` / `pageshow`）でも再実行されます。命令型 tool は
`document.modelContext` の `toolchange` イベントで即座に検知されるため、ポーリングは不要です。

以前のバージョンではここを独自の `window.webMCP` オブジェクトや `<script type="application/webmcp+json">`
で実装していましたが、いずれも WebMCP の実仕様とは異なる誤った実装だったため廃止しました。

## 動作の流れ

1. WebMCP tool が検出されると、ページ右上に **「WebMCPをインストール」** ボタンが表示されます。
2. ボタンを押すと **「WebMCP installed」** に変わり、MCP サーバー側にそのタブが `installed: true` として通知されます。
   この状態はタブ単位・セッションのみで保持され、ページを別 URL へ遷移すると自動的にリセットされます。
3. Antigravity CLI などの MCP クライアントから `webmcp_discover_tools` / `webmcp_call_tool` を呼ぶと、
   拡張機能がそのタブの content script 経由でページ上の tool を実際に実行し、結果を返します。

## サンプルページ

[`examples/webmcp-sample.html`](examples/webmcp-sample.html) に、命令型 (`reserve_hotel`) と
宣言型 (`search_hotels`) 両方のサンプル tool を含むページがあります。`bun run build` 後は
`dist/examples/webmcp-sample.html` として同梱されるので、そのファイルを Chrome で直接開いて確認できます。

## 実機検証で分かったこと

Chrome for Testing 上で実際にこの拡張機能を読み込み、サンプルページに対して
`webmcp_discover_tools` / `webmcp_call_tool` を実際に流し込んで検証したところ、いくつか
コードだけを読んでいては気づけなかった実装上の注意点が見つかりました。

- **`document.modelContext.getTools()` は非同期（Promise）です。** Chrome の開発者ドキュメントの
  要約だけを読むと同期関数に見えましたが、実機（Chrome for Testing 150）で確認したところ
  `Promise<ModelContextTool[]>` を返しました。`executeTool()` も tool 名の文字列ではなく
  `getTools()` で得た tool オブジェクトそのものを要求します（文字列を渡すと `TypeError` になります）。
- **`file://` ページでは `window.location.origin` が `"null"` になります。** `content.ts` と
  `injected.ts` 間の `window.postMessage` の `targetOrigin` にこれを使っていたためハンドシェイクが
  一切成立せず、オーバーレイが表示されない不具合がありました。同じウィンドウ内の
  main world ⇔ isolated world 間通信はそもそもクロスオリジンではないため、`targetOrigin` は `"*"` に
  変更し、代わりに channel id で正当性を担保しています。
- **ネイティブ実装がある場合、宣言型フォームもブラウザ自身が自動登録することがあります。** その場合
  この拡張機能自身の `registerTool()` 呼び出しは「重複」として失敗しますが、これは正常系として扱って
  います（`findAnnotatedFormByName()` で DOM を直接見て `source: "declarative"` と判定するため、
  どちらが登録したかに関わらず正しく報告されます）。またネイティブ合成した `inputSchema` は
  この時点のビルドでは空 (`{ type: "object", properties: {} }`) を返すことがあり、これはブラウザ側の
  実装状況によるもので、この拡張機能側の不具合ではありません。
- **tool の実行結果（`result`）は文字列で返ってくることがあります。** WebMCP 仕様の `execute` は
  本来「エージェント向けの文字列サマリ」を返す想定になっており、ページ側がオブジェクトを返しても
  ブラウザのネイティブ実装が JSON 文字列化して返すことを実機で確認しました。この拡張機能・MCP サーバー
  はどちらも `result` を一切加工せず素通しするので、MCP クライアント側で文字列か構造化データかを
  判定してください。
- **MV3 Service Worker はアイドル状態でサスペンドされ、その間 WebSocket 接続も切れます。** 再度
  `chrome.tabs` イベント等が発生すると自動的に起き上がり `background.ts` の再接続ロジックが働きますが、
  「起動直後に何もタブ操作がない」状態が続くとしばらく `extensionConnected: false` のままになることが
  あります。`webmcp_get_status` / `webmcp_ping` が `false` を返す場合は、対象タブを何か操作（切り替え・
  リロードなど）してみてください。

## セキュリティに関する注意（プロトタイプ前提）

- ページの `main world` (`injected.ts`) と拡張機能の `isolated world` (`content.ts`) 間の
  `window.postMessage` には、ページ読み込みごとに `content.ts` が発行するランダムな channel id を
  一度だけのハンドシェイクで共有し、以降すべてのメッセージに付与しています。無関係なページ
  スクリプトが偽の manifest / 実行結果を送り込めないようにするためです。
- `webmcp-bridge-mcp` 側の WebSocket サーバーは `127.0.0.1` にのみ bind されるため、
  同一マシン以外からは接続できません。個人利用・プロトタイプ用途を前提としており、
  トークン認証などの追加の認可は行っていません。
