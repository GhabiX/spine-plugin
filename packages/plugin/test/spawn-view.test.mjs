import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSpawnAccepted,
  renderSpawnCall,
  spawnAcceptedDetails,
  spawnAcceptedText,
} from "../dist/pi/spawn-view.js";

const theme = {
  fg(_color, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

const tasks = [
  { summary: "inspect auth", prompt: "auth" },
  { summary: "inspect models", prompt: "models" },
  { summary: "inspect providers", prompt: "providers" },
];

test("spawn acceptance lists each task with its activity word", () => {
  const details = spawnAcceptedDetails(tasks);
  assert.deepEqual(details.tasks.map((task) => task.activityWord), ["Germinating", "Budding", "Sprouting"]);
  assert.deepEqual(renderSpawnCall(3, theme).render(80), ["spine_spawn  3 tasks"]);
  // The brand color is ANSI regardless of theme.
  assert.deepEqual(renderSpawnAccepted(details, theme).render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")), [
    "  ├ ◐ Germinating inspect auth",
    "  ├ ◐ Budding inspect models",
    "  └ ◐ Sprouting inspect providers",
  ]);
  assert.deepEqual(renderSpawnAccepted({ unrelated: true }, theme).render(80), ["Spine Spawn"]);
});

test("the model is told results arrive later and the node waits for them", () => {
  const text = spawnAcceptedText(tasks);
  assert.match(text, /accepted 3 tasks/);
  assert.match(text, /arrives later as its own message/);
  assert.match(text, /cannot close until all of them have arrived/);
});
