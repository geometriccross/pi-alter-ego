# pi-alter-ego

- このプロジェクトのAI判断・応答経路を変更するときは `.pi/skills/typesafe-ai/SKILL.md` を読み、そこから関連する最新のTypeSafe公式ドキュメントを確認する。
- Alter Egoの判断はJevのみ。自由文生成モデルや子Piプロセスへのフォールバックを追加しない。表示文は型付き判断と原文引用からコードで構築する。
- 用語は `CONTEXT.md` を参照。
- 通常の検証は `npm run check`。実API検証は `npm run test:live`（`TYPESAFE_API_KEY` 必須、合成例のみ送信）。実セッションや秘密情報を検証用に外部送信しない。
