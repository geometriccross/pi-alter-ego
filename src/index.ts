import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { renderAlterEgoMessage } from "./renderer.js";
import { spawnAlterEgo } from "./spawn.js";
import { extractAssistantTrace, extractLastUserText } from "./trace.js";
import { createAlterEgoState, hasAlterEgoMessage, isDissentableAssistant } from "./state.js";

function renderStatusText(enabled: boolean): string {
  return `\x1b[90mAlter Ego: ${enabled ? "ON" : "OFF"}\x1b[39m`;
}

export default function alterEgoExtension(pi: ExtensionAPI) {
  const state = createAlterEgoState();

  const restoreBranchState = (ctx: { sessionManager: { getBranch(): readonly unknown[] } }) => {
    // getBranch() is leaf→root; createAlterEgoState uses the first matching
    // toggle so branch-local, latest toggle state wins.
    state.restoreFromBranch(ctx.sessionManager.getBranch());
  };

  const updateStatus = (ctx: { hasUI: boolean; ui: any }) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("alter-ego", renderStatusText(state.isEnabled()));
  };

  pi.on("session_start", async (_event, ctx) => {
    restoreBranchState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreBranchState(ctx);
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI || !state.isEnabled()) return;

    const eventMessages = (event.messages as any[]) ?? [];
    if (hasAlterEgoMessage(eventMessages)) return;

    const lastAssistant = [...eventMessages].reverse().find((message) => message.role === "assistant");
    if (!isDissentableAssistant(lastAssistant)) return;

    if (!ctx.model) return;
    const leafId = ctx.sessionManager.getLeafId();
    if (!state.markLeafIfNew(leafId)) return;

    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries() as any, leafId);
    const compactionSummaries = ((sessionContext as any).messages ?? [])
      .filter((message: any) => message?.role === "compactionSummary" && typeof message.summary === "string")
      .map((message: any) => message.summary);
    const trace = extractAssistantTrace(eventMessages);
    const context = buildUserPrompt({
      userMessage: extractLastUserText(eventMessages),
      assistantThinking: trace.thinking,
      assistantFinal: trace.text,
      compactionSummaries,
    });
    const systemPrompt = buildSystemPrompt();
    const model = `${ctx.model.provider}/${ctx.model.id}`;

    try {
      const dissent = await spawnAlterEgo({
        model,
        systemPrompt,
        context,
        timeout: 30_000,
        signal: ctx.signal,
        cwd: ctx.cwd,
      });

      if (!state.isEnabled()) return;
      if (ctx.sessionManager.getLeafId() !== leafId) return;
      if (dissent.trim() === "NO_DISSENT") return;

      pi.sendMessage({
        customType: "alter-ego",
        content: dissent,
        display: true,
        details: { inContext: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "反論の生成に失敗しました";
      ctx.ui.notify(`alter ego: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.resetProcessedLeaves();
    if (ctx.hasUI) ctx.ui.setStatus("alter-ego", undefined);
  });

  pi.registerCommand("alter-ego", {
    description: "Alter Ego のオン/オフを切り替える",
    handler: async (_args, ctx) => {
      const enabled = state.toggle();
      pi.appendEntry("alter-ego-toggle", { enabled });
      updateStatus(ctx);
      ctx.ui.notify(`Alter Ego: ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerMessageRenderer("alter-ego", renderAlterEgoMessage);
}
