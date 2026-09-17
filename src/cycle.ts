import type { JevRequest, JevResponse } from "./jev.js";
import { ok, recoverAsync, type Result } from "./result.js";

export interface DissentDeps {
  evaluate: (request: JevRequest) => Promise<Result<JevResponse>>;
  claimLeaf: (leafId: string) => (() => void) | null;
  isCurrent: () => boolean;
}

export async function runDissent(
  request: JevRequest | null,
  leafId: string,
  deps: DissentDeps,
): Promise<Result<JevResponse | null>> {
  if (request === null || !deps.isCurrent()) {
    return ok(null);
  }

  const release = deps.claimLeaf(leafId);
  if (!release) {
    return ok(null);
  }

  const result = await recoverAsync(
    () => deps.evaluate(request),
    () => "Jev評価に失敗しました",
  );
  const current = deps.isCurrent();
  if (!result.ok || !current) {
    release();
  }
  return current ? result : ok(null);
}
