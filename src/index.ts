import { buildSessionContext, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessDissent, formatDissent } from "./assessment.js";
import { renderAlterEgoMessage } from "./renderer.js";
import { resolveAlterEgoSettings } from "./config.js";
import { createAlterEgoState } from "./state.js";
import { runDissent } from "./cycle.js";

export default function alterEgoExtension(pi: ExtensionAPI) {
  const state = createAlterEgoState();
  const pending = new Set<AbortController>();

  const cancelPending = () => {
    for (const controller of pending) controller.abort();
    pending.clear();
  };
  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("alter-ego", `Alter Ego / Jev: ${state.isEnabled() ? "ON" : "OFF"}`);
  };
  const restore = (ctx: ExtensionContext) => {
    cancelPending();
    state.restoreFromBranch(ctx.sessionManager.getBranch());
    updateStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("agent_start", async () => cancelPending());

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI || !state.isEnabled()) return;
    const leafId = ctx.sessionManager.getLeafId();
    const sourceEntry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!leafId || !sourceEntry) return;
    const sourceLeafId = sourceEntry.id;
    const controller = new AbortController();
    pending.add(controller);
    const onAbort = () => controller.abort();
    const signal = ctx.signal;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const isCurrent = () => !controller.signal.aborted && state.isEnabled() && ctx.sessionManager.getLeafId() === leafId;

    try {
      const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), leafId);
      const assessment = await runDissent(event.messages ?? [], sessionContext, sourceLeafId, {
        evaluate: (input) => assessDissent(input, resolveAlterEgoSettings(ctx.cwd, getAgentDir()), {
          apiKey: process.env.TYPESAFE_API_KEY,
          signal: controller.signal,
        }),
        claimLeaf: (id) => state.claimLeaf(id),
        isCurrent,
      });
      if (assessment === null || !isCurrent()) return;
      const details = { sourceLeafId, assessment };
      const content = formatDissent(assessment);
      if (content === null) {
        // Keep reusable judgments and deduplication data without adding a no-dissent chat message.
        pi.appendEntry("alter-ego-assessment", details);
      } else {
        pi.sendMessage({ customType: "alter-ego", content, display: true, details });
      }
    } catch (error) {
      if (isCurrent()) ctx.ui.notify(`alter ego: ${error instanceof Error ? error.message : "Jev評価に失敗しました"}`, "error");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      pending.delete(controller);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelPending();
    state.resetProcessedLeaves();
    if (ctx.hasUI) ctx.ui.setStatus("alter-ego", undefined);
  });

  pi.registerCommand("alter-ego", {
    description: "Alter Ego (Jev) のオン/オフを切り替える",
    handler: async (_args, ctx) => {
      cancelPending();
      const enabled = state.toggle();
      pi.appendEntry("alter-ego-toggle", { enabled });
      updateStatus(ctx);
      ctx.ui.notify(`Alter Ego / Jev: ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
  pi.registerMessageRenderer("alter-ego", renderAlterEgoMessage);
}
