import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { JevResponse, QuestionHook } from "./evaluation.js";

type DisplayMessage = Pick<Parameters<MessageRenderer>[0], "content" | "details">;

export interface AlterEgoMessageView {
  readonly heading: string;
  readonly content: string;
  readonly details: string | undefined;
}

/**
 * フッターと切替通知で同じ ON/OFF 表記を使うための表示文字列を作る。
 *
 * @param enabled 復元またはコマンドで切り替えた有効状態。API の接続状況や判断結果ではない。
 * @returns ctx.ui.setStatus と ctx.ui.notify に渡す、装飾なしの状態表示。
 */
export function formatEnabledStatus(enabled: boolean): string {
  return `Alter Ego / Jev: ${enabled ? "ON" : "OFF"}`;
}

/**
 * agent_end の評価結果を、表示・保存して会話コンテキストにも含めるカスタムメッセージにする。
 * この関数自身は送信せず、回答を JSON のまま本文に置き、応答全体を展開表示用の details に残す。
 *
 * @param response askJev が返した最終回答に対する評価。自由文や独自の結論に置き換えない。
 * @returns pi.sendMessage に渡すメッセージ。表示時は renderAlterEgoMessage が本文と details を使う。
 */
export function buildDissentMessage(response: JevResponse) {
  return {
    customType: "alter-ego",
    content: JSON.stringify(response.answers, null, 2),
    display: true,
    details: { response },
  };
}

/**
 * agent_end 以外の評価を、会話や継続実行キューに入れずユーザーだけに知らせる通知文にする。
 * フック名と回答の JSON を表示し、端末制御文字などを可視のエスケープ表記に変える。
 *
 * @param hook 評価を発火させたイベント名。保存用メッセージを使う agent_end は受け付けない。
 * @param response askJev の応答。answers のみを通知に載せ、model や usage は表示しない。
 * @returns 拡張の評価処理が ctx.ui.notify に渡す文字列。pi.sendMessage には渡さない。
 */
export function buildHookNotification(hook: Exclude<QuestionHook, "agent_end">, response: JevResponse): string {
  return safeDisplay(`Alter Ego / Jev (${hook})\n${JSON.stringify(response.answers, null, 2)}`);
}

/**
 * 保存済み・新規の Alter Ego メッセージから、テーマや TUI に依存しない表示データを作る。
 * Jev の応答・旧 assessment の印で見出しを区別し、本文中の Markdown は解釈せず、端末制御文字などは可視化する。
 *
 * @param message Pi のカスタムメッセージの本文と details。本文は文字列と保存済みテキストブロックの両方に対応する。
 * @param expanded Pi の展開状態。true のときだけ、存在する details を JSON 表示に含める。
 * @returns renderAlterEgoMessage が Text コンポーネントに配置する見出し・本文・任意の詳細。
 * 元のメッセージは変更せず、表示用データだけを返す。
 */
export function buildAlterEgoMessageView(message: DisplayMessage, expanded: boolean): AlterEgoMessageView {
  const content = typeof message.content === "string" ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const details = message.details as {
    response?: unknown;
    assessment?: { version?: number };
  } | undefined;
  const label = details?.response || details?.assessment?.version === 1 ? "Alter Ego / Jev" : "Alter Ego";
  return {
    heading: `── ${label} ──`,
    content: safeDisplay(content),
    details: expanded && message.details ? safeDisplay(JSON.stringify(message.details, null, 2)) : undefined,
  };
}

// Quotes are data: don't interpret source Markdown or terminal controls.
function safeDisplay(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * alter-ego 用に Pi へ登録するレンダラー。表示データを、引用を Markdown として解釈しない Text の列にする。
 *
 * @param message Pi が表示・再表示するカスタムメッセージ。buildAlterEgoMessageView で表示用に変換する。
 * @param options Pi から渡される描画設定。expanded を詳細の表示切替に使う。
 * @param theme Pi が渡すテーマ。見出しと詳細の色付けだけに使い、元の本文には装飾を加えない。
 * @returns pi.registerMessageRenderer 経由で Pi の TUI が描画する Container。
 */
export const renderAlterEgoMessage: MessageRenderer = (message, options, theme) => {
  const view = buildAlterEgoMessageView(message, options.expanded);
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", view.heading), 1, 0));
  container.addChild(new Text(view.content, 1, 0));
  if (view.details !== undefined) {
    container.addChild(new Text(theme.fg("dim", view.details), 1, 0));
  }
  return container;
};
