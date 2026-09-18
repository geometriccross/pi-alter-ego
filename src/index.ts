import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig, questionsForHook } from "./config.js";
import { askJev, prepareRequest, type QuestionEvent } from "./evaluation.js";
import { buildDissentMessage, buildHookNotification, formatEnabledStatus, renderAlterEgoMessage } from "./output.js";

export function restoreEnabled(branch: readonly SessionEntry[]): boolean {
  // SessionManager.getBranch() is ordered root -> leaf.
  return branch.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "alter-ego-toggle") return [];
    const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    return typeof enabled === "boolean" ? [enabled] : [];
  }).at(-1) ?? true;
}

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
