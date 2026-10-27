import type { Context } from "@deepseek-ai/cordis";

/** The Cordis plugin DeepSeek Harness loads, by package name, from a bundle. */
export const name = "spinejit";
export const inject = ["agents", "llm", "sessions", "systemPrompt", "tools"];

export function apply(_ctx: Context): void {}
