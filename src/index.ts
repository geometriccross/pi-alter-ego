import { buildSessionContext, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { renderAlterEgoMessage } from "./renderer.js";
import { spawnAlterEgo } from "./spawn.js";
import { resolveAlterEgoModel, resolveAlterEgoTimeout } from "./config.js";
import { serializeEvidence } from "./evidence.js";
import { createAlterEgoState } from "./state.js";
import { runDissent, type DissentInput } from "./cycle.js";

function renderStatusText(enabled: boolean): string {
  return `\x1b[90mAlter Ego: ${enabled ? "ON" : "OFF"}\x1b[39m`;
}

export default function alterEgoExtension(pi: ExtensionAPI) {
  const state = createAlterEgoState();

  const restoreBranchState = (ctx: { sessionManager: { getBranch(): readonly unknown[] } }) => {
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
    if (!ctx.model) return;

    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return;
    const sessionContext = buildSessionContext(ctx.sessionManager.getEntries() as any, leafId);

    const model = resolveAlterEgoModel(ctx.cwd, getAgentDir(), `${ctx.model.provider}/${ctx.model.id}`);
    const systemPrompt = buildSystemPrompt();

    const spawn = (input: DissentInput) => {
      const context = buildUserPrompt({
        userMessage: input.userText,
        assistantThinking: input.assistantTrace.thinking,
        assistantFinal: input.assistantTrace.text,
        compactionSummaries: input.compactionSummaries,
        visibleExecutionEvidence: serializeEvidence(input.evidenceDigest),
      });
      const timeout = resolveAlterEgoTimeout(ctx.cwd, getAgentDir()) * 1000;
      return spawnAlterEgo({ model, systemPrompt, context, timeout, signal: ctx.signal, cwd: ctx.cwd });
    };

    try {
      const dissent = await runDissent(
        event.messages as any[] ?? [],
        sessionContext,
        leafId,
        {
          spawn,
          isEnabled: () => state.isEnabled(),
          markLeafIfNew: (id) => state.markLeafIfNew(id),
          getCurrentLeafId: () => ctx.sessionManager.getLeafId(),
        },
      );

      if (dissent !== null) {
        pi.sendMessage({
          customType: "alter-ego",
          content: dissent,
          display: true,
          details: { inContext: true },
        });
      }
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
