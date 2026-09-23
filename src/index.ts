import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig, questionsForHook } from "./config.js";
import { askJev, prepareRequest, type QuestionEvent } from "./evaluation.js";
import { buildDissentMessage, buildHookNotification, formatEnabledStatus, renderAlterEgoMessage } from "./output.js";

/**
 * セッション再開やツリー移動の後に、そのブランチでの Alter Ego の ON/OFF を復元する。
 * 他の拡張の記録や不正な値を無視し、最後の有効な alter-ego-toggle だけを採用する。
 *
 * @param branch SessionManager.getBranch() が返す、ルートから現在の葉までの順序付き履歴。
 * 全ブランチのエントリではなく、復元対象の経路だけを渡す。
 * @returns 拡張の評価可否と formatEnabledStatus による表示に使う有効状態。記録がなければ true。
 */
export function restoreEnabled(branch: readonly SessionEntry[]): boolean {
  return branch.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "alter-ego-toggle") return [];
    const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    return typeof enabled === "boolean" ? [enabled] : [];
  }).at(-1) ?? true;
}

/**
 * Pi が読み込む拡張の入口。評価フック、ON/OFF コマンド、状態復元、メッセージ描画を接続する。
 * 初期化時には通信せず、後続のフックで UI が利用可能かつ有効な場合に設定を読み、Jev の判断を表示する。
 *
 * @param pi Pi の拡張ローダーから渡される API。ハンドラ登録、切替状態の保存、最終評価メッセージの送信に使う。
 * @returns 戻り値はない。登録したハンドラと renderAlterEgoMessage を Pi が後から呼び出す。
 */
export default function alterEgoExtension(pi: ExtensionAPI) {
  let enabled = true;
  let prompt: string | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("alter-ego", formatEnabledStatus(enabled));
    }
  };

  const evaluate = async (event: QuestionEvent, ctx: ExtensionContext) => {
    if (event.type === "session_start" || event.type === "session_tree") {
      enabled = restoreEnabled(ctx.sessionManager.getBranch());
      prompt = undefined;
      updateStatus(ctx);
    } else if (event.type === "before_agent_start") {
      prompt = event.prompt;
    }
    if (!ctx.hasUI || !enabled) return;

    const config = loadConfig(ctx.cwd);
    const questions = questionsForHook(config.questions, event.type);
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const request = prepareRequest(event, entries, leafId, questions, prompt);
    if (request === null) return;

    const response = await askJev(request, { apiKey: config.apiKey, signal: ctx.signal });
    if (event.type === "agent_end") {
      pi.sendMessage(buildDissentMessage(response));
    } else {
      // Intermediate judgments must not enter the agent's context or continuation queues.
      ctx.ui.notify(buildHookNotification(event.type, response), "info");
    }
  };

  pi.on("session_start", evaluate);
  pi.on("session_tree", evaluate);
  pi.on("session_compact", evaluate);
  pi.on("input", evaluate);
  pi.on("before_agent_start", evaluate);
  pi.on("agent_start", evaluate);
  pi.on("agent_end", evaluate);
  pi.on("turn_start", evaluate);
  pi.on("turn_end", evaluate);
  pi.on("context", evaluate);
  pi.on("message_end", evaluate);
  pi.on("tool_call", evaluate);
  pi.on("tool_result", evaluate);
  pi.on("tool_execution_start", evaluate);
  pi.on("tool_execution_end", evaluate);

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("alter-ego", undefined);
  });

  pi.registerCommand("alter-ego", {
    description: "Alter Ego (Jev) のオン/オフを切り替える",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      pi.appendEntry("alter-ego-toggle", { enabled });
      updateStatus(ctx);
      ctx.ui.notify(formatEnabledStatus(enabled), "info");
    },
  });

  pi.registerMessageRenderer("alter-ego", renderAlterEgoMessage);
}
