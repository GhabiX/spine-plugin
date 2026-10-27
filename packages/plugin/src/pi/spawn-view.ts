import type { SpawnTask } from "@spinejit/spine-sdk";

import { linesComponent, spineBrand, type SpineTheme } from "./pretty-tree.js";

const ACTIVITY_WORDS = [
  "Germinating",
  "Budding",
  "Sprouting",
  "Rooting",
  "Branching",
  "Unfurling",
  "Blooming",
  "Flourishing",
  "Sketching",
  "Shaping",
  "Layering",
  "Weaving",
  "Composing",
  "Rendering",
  "Unfolding",
  "Evolving",
  "Awakening",
  "Becoming",
  "Emerging",
  "Stirring",
  "Quickening",
  "Kindling",
  "Growing",
  "Greening",
  "Blossoming",
  "Ripening",
  "Renewing",
  "Cultivating",
  "Nurturing",
  "Deepening",
  "Flowing",
  "Gathering",
  "Coalescing",
  "Distilling",
  "Refining",
  "Crystallizing",
  "Illuminating",
  "Glimmering",
  "Resonating",
  "Materializing",
] as const;

/** The spine_spawn tool result: the tasks were accepted; their children start after the turn. */
export interface SpawnAcceptedDetails {
  schema: "spine.spawn.accepted/v1";
  tasks: { summary: string; activityWord: string }[];
}

export function spawnAcceptedDetails(tasks: readonly SpawnTask[]): SpawnAcceptedDetails {
  const used = new Set<string>();
  return {
    schema: "spine.spawn.accepted/v1",
    tasks: tasks.map((task, ordinal) => ({
      summary: task.summary.trim(),
      activityWord: assignActivityWord(ordinal, used),
    })),
  };
}

export function spawnAcceptedText(tasks: readonly SpawnTask[]): string {
  return `Spine Spawn accepted ${tasks.length} tasks. Each child starts when this turn ends, and its result arrives later as its own message. This node cannot close until all of them have arrived.`;
}

export function renderSpawnCall(taskCount: number, theme: SpineTheme) {
  const count = taskCount === 1 ? "1 task" : `${taskCount} tasks`;
  return linesComponent([`${theme.fg("toolTitle", theme.bold("spine_spawn"))}  ${theme.fg("dim", count)}`]);
}

export function renderSpawnAccepted(details: unknown, theme: SpineTheme) {
  if (!isAccepted(details)) return linesComponent(["Spine Spawn"]);
  return linesComponent(details.tasks.map((task, index) => {
    const branch = theme.fg("dim", index + 1 === details.tasks.length ? "  └ " : "  ├ ");
    return `${branch}${spineBrand("◐", theme)} ${spineBrand(task.activityWord, theme)} ${task.summary}`;
  }));
}

function isAccepted(details: unknown): details is SpawnAcceptedDetails {
  return typeof details === "object" && details !== null &&
    (details as { schema?: unknown }).schema === "spine.spawn.accepted/v1" &&
    Array.isArray((details as { tasks?: unknown }).tasks);
}

function assignActivityWord(ordinal: number, used: Set<string>): string {
  const base = ACTIVITY_WORDS[ordinal % ACTIVITY_WORDS.length] ?? "Unfolding";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let word = `Further ${base}`;
  while (used.has(word)) word = `Further ${word}`;
  used.add(word);
  return word;
}
