import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SpawnAlterEgoOptions {
  model: string;
  systemPrompt: string;
  context: string;
  timeout: number;
  signal?: AbortSignal;
  cwd: string;
}

export interface BuildArgsOptions {
  model: string;
  systemPromptPath: string;
  context: string;
  maxPromptLength?: number;
}

export function buildAlterEgoArgs(opts: BuildArgsOptions): string[] {
  const prompt = truncatePromptArg(opts.context, opts.maxPromptLength ?? 100_000);
  return [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--model",
    opts.model,
    "--system-prompt",
    opts.systemPromptPath,
    prompt,
  ];
}

export async function spawnAlterEgo(opts: SpawnAlterEgoOptions): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-alter-ego-"));
  const systemPromptPath = path.join(tmpDir, "system-prompt.txt");

  try {
    await fs.promises.writeFile(systemPromptPath, opts.systemPrompt, { encoding: "utf-8", mode: 0o600 });
    const args = buildAlterEgoArgs({ model: opts.model, systemPromptPath, context: opts.context });
    return await runPi(args, opts.cwd, opts.timeout, opts.signal);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

export function extractFinalAssistantText(jsonl: string): string | null {
  let lastAssistantText = "";

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        event.type === "message_end" &&
        event.message?.role === "assistant" &&
        event.message.stopReason !== "error" &&
        event.message.stopReason !== "aborted"
      ) {
        const text = Array.isArray(event.message.content)
          ? event.message.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
          : "";
        if (text.trim()) lastAssistantText = text;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  return lastAssistantText || null;
}

function truncatePromptArg(context: string, maxPromptLength: number): string {
  if (context.length <= maxPromptLength) return context;
  return `[古いコンテキストは長さ制限のため省略されました]\n\n${context.slice(-maxPromptLength)}`;
}

function runPi(args: string[], cwd: string, timeout: number, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("キャンセルされました"));
      return;
    }

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => finish(() => {
      proc.kill("SIGKILL");
      reject(new Error("キャンセルされました"));
    });

    const timer = setTimeout(() => finish(() => {
      proc.kill("SIGKILL");
      reject(new Error(`タイムアウト (${Math.round(timeout / 1000)}s)`));
    }), timeout);

    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (err) => finish(() => reject(err)));
    proc.on("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `終了コード: ${code}`));
        return;
      }
      const dissent = extractFinalAssistantText(stdout);
      if (!dissent) {
        reject(new Error("反論テキストを抽出できませんでした"));
        return;
      }
      resolve(dissent);
    }));
  });
}
