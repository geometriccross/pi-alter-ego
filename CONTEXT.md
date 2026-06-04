# pi-alter-ego

pi の拡張機能。メインエージェントの思考過程と最終回答のズレを検出し、ユーザーの判断材料とする Reasoning Dissenter。

## Language

**Alter Ego**:
メインエージェントの reasoning trace（thinking）と最終回答（final answer）を比較し、両者の間のズレを検出するエージェント。各プロンプトサイクルの終了後に、独立したプロセスとして起動される。
_Avoid_: reviewer、反対役、devil's advocate、opponent

**Reasoning Dissent**:
Alter Ego が検出した、思考過程から最終回答への変換における問題点。不確実性の消失、懸念の削除、過剰な断定等。
_Avoid_: 反論、オブジェクション、レビュー

**Dissentable（反論可能）**:
Alter Ego が Reasoning Dissent を生成する対象となる、メインエージェントの最終的なテキスト応答。ツール呼び出しの中間ターンは含まない。
_Avoid_: ターン、応答

**Assistant Trace**:
メインエージェントの assistant message から抽出された thinking と final answer のペア。Alter Ego の主要な入力。

## Relationships

- **ユーザー** → **メインエージェント** にプロンプトを送る
- **メインエージェント** → Dissentable（thinking + final answer 含む）を生成して応答完了
- **Alter Ego** → Assistant Trace + compaction summaries を受け取り、Reasoning Dissent を生成
- **Reasoning Dissent** → セッションに注入され、以降のメインエージェントの文脈に含まれる

## Example Dialogue

```
ユーザー: この関数はこれでリリースしていい？
メインエージェント thinking: 空文字のケース...でもテスト通ってるから大丈夫か
メインエージェント: テストも通っているので問題ありません。
Alter Ego: ⚠️ thinking では「空文字のケース」に触れているが、final answer でその懸念が理由なく消失している。バリデーション漏れの可能性。
ユーザー: バリデーション追加して
メインエージェント: （Reasoning Dissent を考慮して）空文字列のバリデーションを追加しました。
```
