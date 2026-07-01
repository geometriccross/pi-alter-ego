# pi-alter-ego 実装仕様

## ファイル構成

```
pi-alter-ego/src/
├── index.ts          # エントリーポイント — thin adapter
├── extract.ts        # pi メッセージ形状の知識を一箇所に集約
├── cycle.ts          # Reasoning Dissent サイクル全体（deep module）
├── state.ts          # ランタイム状態（toggle / processedLeaves）
├── config.ts         # モデル設定解決（プロジェクト > グローバル > fallback）
├── spawn.ts          # 子プロセス管理（pi バイナリの spawn）
├── prompt.ts         # システムプロンプト + ユーザープロンプト構築
├── renderer.ts       # メッセージレンダラー
└── evidence.ts       # ツール実行証跡の集約・シリアライズ
```

## アーキテクチャ

### Deep modules

2つの deep module がコアロジックを隠蔽する:

1. **`extract.ts`** — pi の `messages: any[]` を型付きデータに変換。`any` キャストをこのモジュールの内側に封じ、下流は型付き値だけを消費する。
   - `extractAssistantTrace` / `extractTraceFromAssistant` — thinking + text 抽出
   - `extractLastUserText` — 最後の user テキスト
   - `hasAlterEgoMessage` / `isDissentableAssistant` — 事前ガード
   - `findLastAssistant` — 重複スキャン防止
   - `extractCompactionSummaries` — コンパクション要約抽出
   - `buildEvidenceDigest` / `serializeEvidence` (evidence.ts から re-export)

2. **`cycle.ts`** — Reasoning Dissent サイクル全体。1インターフェース (`runDissent`) の背後に全判断を隠す。
   - 入力: `messages` + `sessionContext` + `leafId` + `DissentDeps`
   - `DissentDeps.spawn` は adapter がプリビルドしたクロージャ（モデル解決・プロンプト構築済み）
   - 出力: dissent 文字列 (`string | null`)

### index.ts（thin adapter）

`agent_end` ハンドラは adapter のみ:
- `ctx` と `event` から `sessionContext` と `leafId` を抽出
- `spawn` クロージャを構築（model 解決 + prompt 構築 + timeout/signal 設定）
- `runDissent` を呼び出し
- 結果が非 null なら `pi.sendMessage`

## モデル設定（config.ts）

Alter Ego が使用するモデルは以下の優先順位で解決:

1. プロジェクト設定: `<cwd>/.pi/alter-ego.json`
2. グローバル設定: `~/.pi/agent/alter-ego.json`
3. フォールバック: メインエージェントと同じモデル

## cycle.ts — Dissent サイクル

```typescript
export interface DissentInput {
  userText: string;
  assistantTrace: AssistantTrace;
  evidenceDigest: EvidenceItem[];
  compactionSummaries: string[];
}

export interface DissentDeps {
  spawn: (input: DissentInput) => Promise<string>;
  isEnabled: () => boolean;
  markLeafIfNew: (leafId: string) => boolean;
  getCurrentLeafId: () => string | null;
}

export async function runDissent(
  messages: readonly unknown[],
  sessionContext: unknown,
  leafId: string,
  deps: DissentDeps,
): Promise<string | null>;
```

### 判断フロー

1. `hasAlterEgoMessage(messages)` → null（既に alter-ego 応答あり）
2. `findLastAssistant` → `isDissentableAssistant` → null（停止理由が toolUse/error/aborted、または text なし）
3. `extractTraceFromAssistant` → 空 thinking → null（thinking なしモデル）
4. `markLeafIfNew(leafId)` → null（処理済み leaf）
5. DissentInput を構築 → `deps.spawn(input)` で反論生成
6. レースガード: `isEnabled()` → null（spawn 中にトグルオフ）
7. レースガード: `getCurrentLeafId() !== leafId` → null（spawn 中にナビゲーション）
8. `dissent.trim() === "NO_DISSENT"` → null
9. dissent を返す

## extract.ts — メッセージ抽出

`trace.ts` / `state.ts` は `extract.ts` へ委譲し、後方互換のために re-export する。

`findLastAssistant` → `extractTraceFromAssistant` の組み合わせで、
「最後の assistant を逆順探索」の重複を排除（旧: index.ts と trace.ts で
別々に走査）。

## spawn.ts — 子プロセス管理

- pi バイナリを `getPiInvocation()` で解決
- システムプロンプトを一時ファイルに書き出し `--system-prompt` でファイルパス指定
- ユーザープロンプトは引数で直接渡す（100KB 超は切り詰め）
- 30秒タイムアウト + AbortSignal 対応
- JSONL 出力から最終 assistant テキストを `extractFinalAssistantText` で抽出

## prompt.ts — プロンプト構築

- `buildSystemPrompt()` — Alter Ego 指示（固定）
- `buildUserPrompt(opts)` — `<reasoning_dissent_input>` XML セクションを構築
  - `user_message`, `assistant_thinking`, `assistant_final`（必須）
  - `compaction_summaries`, `visible_execution_evidence`（任意）

## evidence.ts — ツール実行証跡

- `buildEvidenceDigest(messages)` — toolCall/toolResult をペアリングし最大12件に制限
- `serializeEvidence(items)` — `<visible_execution_evidence>` XML にシリアライズ
- バッシュコマンドの分類（test/typecheck/build/lint/git/install/file-inspect）
- テスト集計行の解析（Vitest/Jest/pytest）

## state.ts — ランタイム状態

- `createAlterEgoState()` — toggle 状態 + processedLeaves Set
- `restoreFromBranch` — leaf→root ブランチからトグル状態復元
- `toggle()` / `isEnabled()` / `markLeafIfNew()` / `resetProcessedLeaves()`
- メッセージ判定関数は extract.ts へ委譲
