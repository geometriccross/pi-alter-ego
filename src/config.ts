import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevQuestion, JevRequest, QuestionHook } from "./evaluation.js";

export type ConfiguredQuestion = JevQuestion & { readonly on?: QuestionHook | readonly QuestionHook[] };

export interface AlterEgoConfig {
  readonly questions: Readonly<Record<string, ConfiguredQuestion>>;
  readonly apiKey: string | undefined;
}

/**
 * 設定の解釈をファイル読込や環境変数から切り離し、質問と認証情報をまとめる。
 * 質問のスキーマ検証はせず、questions が未指定なら空の質問集合を使う。
 *
 * @param text 読込済みの alter-ego.json の本文。質問の内容や on 指定をそのまま保持する。
 * @param apiKey 呼び出し元が取得した認証情報。JSON 内のキーや環境変数はここでは参照しない。
 * @returns loadConfig が返す設定値。questions は questionsForHook、apiKey は askJev に渡す。
 * @throws JSON 解析などの失敗は呼び出し元へ伝播する。
 */
export function parseConfig(text: string, apiKey: string | undefined): AlterEgoConfig {
  const config = JSON.parse(text) as { questions?: AlterEgoConfig["questions"] };
  return { questions: config.questions ?? {}, apiKey };
}

/**
 * 発火したフックに対応する質問を、1回の Jev 評価にまとめるために選び出す。
 * on の省略は agent_end とし、送信不要な on だけを取り除く。元の設定は変更しない。
 *
 * @param questions loadConfig で取得した、フック指定を含む質問集合。
 * @param hook 今回発火した Pi イベントの種別。質問の on と照合する。
 * @returns prepareRequest の questions に渡す、質問 ID を維持した集合。
 * 対応する質問がなければ空になり、prepareRequest 側で評価を省略できる。
 */
export function questionsForHook(questions: AlterEgoConfig["questions"], hook: QuestionHook): JevRequest["questions"] {
  return Object.fromEntries(Object.entries(questions).flatMap(([id, { on = "agent_end", ...question }]) => {
    const hooks = typeof on === "string" ? [on] : on;
    return hooks.includes(hook) ? [[id, question]] : [];
  }));
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * イベントごとに設定と環境変数を読み直し、再起動せずに設定変更を反映する。
 * プロジェクトの .pi/alter-ego.json を優先し、存在しない場合だけ getAgentDir() 配下を読む。
 * 両者の質問はマージせず、どちらもなければ質問なしとして扱う。
 *
 * @param projectCwd Pi の ctx.cwd。プロジェクト設定を探す基点であり、設定ファイル自体のパスではない。
 * @returns 拡張の評価処理で questionsForHook に渡す質問と、askJev に渡す TYPESAFE_API_KEY。
 * @throws ファイル不在以外の読込エラーや解析エラー。壊れた設定を別の設定で隠さない。
 */
export function loadConfig(projectCwd: string): AlterEgoConfig {
  const text = readOptionalFile(join(projectCwd, ".pi", "alter-ego.json"))
    ?? readOptionalFile(join(getAgentDir(), "alter-ego.json"))
    ?? "{}";
  return parseConfig(text, process.env.TYPESAFE_API_KEY);
}
