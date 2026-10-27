import type { SpawnTask, SpineOperation } from "../index.js";
import { validateSpineToolInput, type SpineToolInput } from "../node.js";

export const SPINE_TOOL_NAMES = [
  "spine_open",
  "spine_close",
  "spine_next",
  "spine_spawn",
] as const;

export type SpineToolName = (typeof SPINE_TOOL_NAMES)[number];

export class SpineToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpineToolInputError";
  }
}

export function isSpineToolName(name: string): name is SpineToolName {
  return (SPINE_TOOL_NAMES as readonly string[]).includes(name);
}

export function operationFromSpineToolCall(
  toolName: SpineToolName,
  input: Record<string, unknown>,
): SpineOperation {
  switch (toolName) {
    case "spine_open": return validateInput("open", input);
    case "spine_close": return validateInput("close", input);
    case "spine_next": return validateInput("next", input);
    case "spine_spawn": return validateInput("spawn", input);
  }
}

export function decodeSpineSpawnTasks(input: Record<string, unknown>): SpawnTask[] {
  return validateInput("spawn", input).tasks;
}

function validateInput<T extends SpineToolInput["type"]>(
  tool: T,
  input: Record<string, unknown>,
): Extract<SpineToolInput, { type: T }> {
  try {
    return validateSpineToolInput(tool, input);
  } catch (cause) {
    throw new SpineToolInputError(String(cause));
  }
}
