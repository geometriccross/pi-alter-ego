import { setTimeout as delay } from "node:timers/promises";
import {
  JEV_UNAVAILABLE, parseJevResponse, prepareJevRequest, retryDelay,
  type JevRequest, type JevResponse, type PreparedJevRequest,
} from "./jev-protocol.js";
import { andThen, andThenAsync, err, map, ok, recoverAsync, type Result } from "./result.js";

export type { JevDescription, JevQuestion, JevRequest, NoulAnswer, ChoiceAnswer, ScoreAnswer, JevResponse } from "./jev-protocol.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 30_000;

export interface JevOptions {
  readonly apiKey: string | undefined;
  readonly signal?: AbortSignal;
}

function createRequestScope(signal?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();

  let timedOut = false;
  const abortMessage = () => timedOut
    ? `Jev タイムアウト (${TIMEOUT_MS / 1000}s、未評価)`
    : "Jev評価をキャンセルしました";
  // All attempts and backoff share one deadline.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  return {
    signal: controller.signal,
    checkActive: (): Result<void> => controller.signal.aborted ? err(abortMessage()) : ok(undefined),
    failureMessage: () => controller.signal.aborted ? abortMessage() : JEV_UNAVAILABLE,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function fetchPayload(
  request: PreparedJevRequest,
  scope: ReturnType<typeof createRequestScope>,
  fetchImpl: typeof fetch,
  attempt = 0,
): Promise<Result<unknown>> {
  return andThenAsync(scope.checkActive(), async () => {
    const response = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: request.body,
      signal: scope.signal,
      redirect: "error",
    });

    if (!response.ok) {
      await response.body?.cancel();
      const wait = retryDelay(response.status, response.headers.get("retry-after"), attempt, Date.now());
      if (wait !== null) {
        await delay(wait, undefined, { signal: scope.signal });
        return fetchPayload(request, scope, fetchImpl, attempt + 1);
      }
      // Service bodies may echo state or credentials. Do not expose them in notifications.
      return andThen(scope.checkActive(), () => err(`Jev API: HTTP ${response.status}（未評価）`));
    }

    const payload: unknown = await response.json();
    return map(scope.checkActive(), () => payload);
  });
}

export function askJev(
  request: JevRequest,
  options: JevOptions,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Result<JevResponse>> {
  return andThenAsync(prepareJevRequest(request, options.apiKey), (prepared) => {
    const scope = createRequestScope(options.signal);
    return recoverAsync(async () => andThen(
      await fetchPayload(prepared, scope, fetchImpl),
      (payload) => parseJevResponse(payload, request.questions),
    ), scope.failureMessage).finally(scope.dispose);
  });
}
