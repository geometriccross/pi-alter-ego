import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev } from "./jev.js";
import { renderAlterEgoMessage } from "./renderer.js";
import { createAlterEgoState } from "./state.js";
import { runDissent } from "./cycle.js";
import { loadConfig } from "./config.js";
import { andThen, andThenAsync, ok, recoverAsync } from "./result.js";
import {
  buildDissentMessage,
  findDissentSource,
  formatDissentError,
  prepareDissentRequest,
} from "./dissent.js";

function trackPending(pending: Set<AbortController>, signal?: AbortSignal) {
  const controller = new AbortController();
  pending.add(controller);

  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    dispose() {
      signal?.removeEventListener("abort", onAbort);
      pending.delete(controller);
    },
  };
}

export default function alterEgoExtension(pi: ExtensionAPI) {
  const state = createAlterEgoState();
  const pending = new Set<AbortController>();

  const cancelPending = () => {
    for (const controller of pending) {
      controller.abort();
    }
    pending.clear();
  };

  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("alter-ego", `Alter Ego / Jev: ${state.isEnabled() ? "ON" : "OFF"}`);
    }
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
    if (!ctx.hasUI || !state.isEnabled()) {
      return;
    }

    const source = findDissentSource(ctx.sessionManager.getLeafId(), ctx.sessionManager.getBranch());
    if (!source) {
      return;
    }

    const evaluation = trackPending(pending, ctx.signal);
    const isCurrent = () =>
      !evaluation.signal.aborted &&
      state.isEnabled() &&
      ctx.sessionManager.getLeafId() === source.leafId;

    const result = await recoverAsync(async () => {
      const response = await andThenAsync(loadConfig(ctx.cwd), ({ questions, apiKey }) => {
        const request = prepareDissentRequest(
          event.messages ?? [], ctx.sessionManager.getEntries(), source.leafId, questions,
        );
        return runDissent(request, source.sourceLeafId, {
          evaluate: (request) => askJev(request, { apiKey, signal: evaluation.signal }),
          claimLeaf: (id) => state.claimLeaf(id),
          isCurrent,
        });
      });
      return andThen(response, (value) => {
        if (value !== null && isCurrent()) {
          pi.sendMessage(buildDissentMessage(source.sourceLeafId, value));
        }
        return ok(undefined);
      });
    }, () => "Jev評価に失敗しました").finally(evaluation.dispose);

    if (!result.ok && isCurrent()) {
      ctx.ui.notify(formatDissentError(result.error), "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelPending();
    state.resetProcessedLeaves();
    if (ctx.hasUI) {
      ctx.ui.setStatus("alter-ego", undefined);
    }
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
