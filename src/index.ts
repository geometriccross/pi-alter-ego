import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev, type JevResponse } from "./jev.js";
import { renderAlterEgoMessage, safeDisplay } from "./renderer.js";
import { createAlterEgoState } from "./state.js";
import { runDissent } from "./cycle.js";
import { loadConfig, questionsForHook } from "./config.js";
import { prepareHookRequest, type HookEvent } from "./hooks.js";
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
  let prompt: string | undefined;
  let configError: string | undefined;

  const readConfig = (ctx: ExtensionContext) => {
    const config = loadConfig(ctx.cwd);
    if (!config.ok && config.error !== configError) {
      ctx.ui.notify(formatDissentError(config.error), "error");
    }
    configError = config.ok ? undefined : config.error;
    return config;
  };

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
    prompt = undefined;
    state.restoreFromBranch(ctx.sessionManager.getBranch());
    updateStatus(ctx);
  };

  const evaluateHook = async (event: HookEvent, ctx: ExtensionContext) => {
    if (!ctx.hasUI || !state.isEnabled() || ctx.signal?.aborted) return;
    const config = readConfig(ctx);
    if (!config.ok) return;
    const questions = questionsForHook(config.value.questions, event.type);
    if (Object.keys(questions).length === 0) return;

    const leafId = ctx.sessionManager.getLeafId();
    const sessionId = ctx.sessionManager.getSessionId();
    const evaluation = trackPending(pending, ctx.signal);
    const isCurrent = () =>
      !evaluation.signal.aborted && state.isEnabled() &&
      ctx.sessionManager.getSessionId() === sessionId &&
      (leafId === null || ctx.sessionManager.getBranch().some((entry) => entry.id === leafId));

    const result = await recoverAsync<JevResponse | null, string>(async () => {
      const request = prepareHookRequest(event, ctx.sessionManager.getEntries(), leafId, questions, prompt);
      return request && isCurrent()
        ? askJev(request, { apiKey: config.value.apiKey, signal: evaluation.signal })
        : ok(null);
    }, () => "Jev評価に失敗しました").finally(evaluation.dispose);

    if (!isCurrent()) return;
    if (!result.ok) {
      ctx.ui.notify(formatDissentError(result.error), "error");
    } else if (result.value !== null) {
      // Steering from a turn/message hook can cause an endless evaluate -> agent turn loop.
      // Keep intermediate judgments out of the agent's context and continuation queues.
      pi.appendEntry("alter-ego-hook-assessment", { hook: event.type, sourceLeafId: leafId, response: result.value });
      ctx.ui.notify(safeDisplay(`Alter Ego / Jev (${event.type})\n${JSON.stringify(result.value.answers, null, 2)}`), "info");
    }
  };

  pi.on("session_start", async (event, ctx) => {
    restore(ctx);
    await evaluateHook(event, ctx);
  });
  pi.on("session_tree", async (event, ctx) => {
    restore(ctx);
    await evaluateHook(event, ctx);
  });
  pi.on("agent_start", async (event, ctx) => {
    cancelPending();
    await evaluateHook(event, ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    prompt = event.prompt;
    await evaluateHook(event, ctx);
  });
  pi.on("session_compact", evaluateHook);
  pi.on("input", evaluateHook);
  pi.on("turn_start", evaluateHook);
  pi.on("turn_end", evaluateHook);
  pi.on("context", evaluateHook);
  pi.on("message_end", evaluateHook);
  pi.on("tool_call", evaluateHook);
  pi.on("tool_result", evaluateHook);
  pi.on("tool_execution_start", evaluateHook);
  pi.on("tool_execution_end", evaluateHook);

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
      const config = readConfig(ctx);
      if (!config.ok) return ok(undefined);
      const response = await andThenAsync(config, ({ questions, apiKey }) => {
        const request = prepareDissentRequest(
          event.messages ?? [], ctx.sessionManager.getEntries(), source.leafId, questionsForHook(questions, "agent_end"),
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
