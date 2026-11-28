// Agent presets compose their own compaction group in an isolated realm that
// the bundle patch cannot reach. These tests resolve the real Web presets and
// mount the real compaction-basic and tool-result-pruner in such a realm.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import TokenMeter from "@deepseek-ai/dsh-token-meter";

import { checkpoints, ends, mountCompact, overflow, summary, text } from "./compact-helpers.mjs";

const PRESETS = ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"];
/** An installed DSH host with @deepseek-ai/dsh-web-app, e.g. the host-matrix install of the same release. */
const WEB_HOST = process.env.DSH_WEB_HOST;

/** Compose dsh-base, the Web bundle and its presets, and this bundle's patch, as DSH's app boot does. */
async function composeWeb(host) {
  const require = createRequire(join(host, "package.json"));
  const yaml = require("js-yaml");
  const boot = await import(require.resolve("@deepseek-ai/dsh-app-boot"));
  const js = new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (source) => ({ __jsExpr: source }) });
  const schema = yaml.DEFAULT_SCHEMA.extend([js]);
  const read = async (file) => yaml.load(await readFile(file, "utf8"), { schema }) ?? [];
  const dir = (name) => join(host, "node_modules", name);
  const web = JSON.parse(await readFile(join(dir("@deepseek-ai/dsh-web-app"), "package.json"), "utf8"));
  const layers = [await read(join(dir("@deepseek-ai/dsh-base"), "cordis.patch.yml"))];
  for (const patch of web.dsh.bundle.patch) layers.push(await read(join(dir("@deepseek-ai/dsh-web-app"), patch)));
  layers.push(await read(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url))));
  const warnings = [];
  const entries = boot.composeEntries(layers, (...args) => warnings.push(args.join(" ")));
  const all = [];
  const walk = (rows) => { for (const row of rows) { all.push(row); if (row.group && Array.isArray(row.config)) walk(row.config); } };
  walk(entries);
  return { version: web.version, warnings, all };
}

test("real Web presets: the bundle patch composes cleanly and every preset still declares its own compaction group", { skip: WEB_HOST === undefined && "set DSH_WEB_HOST to an installed DSH host" }, async () => {
  const { version, warnings, all } = await composeWeb(WEB_HOST);
  assert.deepEqual(warnings, [], `DSH ${version}`);
  const root = (id) => all.find((row) => row.id === id);
  assert.equal(root("compaction-basic").disabled, true);
  assert.equal(root("tool-result-pruner").disabled, true);
  // dsh-web-app disables root command-compact and moves it into each preset compaction group; our patch does not disable it.
  assert.equal(root("spinejit").name, "@spinejit/dsh-spinejit");
  assert.equal(root("spinejit-compact").name, "@spinejit/dsh-spinejit/compact");
  for (const id of PRESETS) {
    const preset = root(id);
    assert.equal(preset?.name, "@deepseek-ai/dsh-agent-preset", `${id} on DSH ${version}`);
    const group = preset.config.plugins.find((row) => row.id === "compaction");
    // Out of reach of id patches: the preset row is not a group, and a config
    // patch would replace the whole preset. Spine must bind it at runtime.
    assert.equal(group.isolate.compaction, true);
    assert.ok(group.config.some((row) => row.name === "@deepseek-ai/dsh-compaction-basic" && row.disabled !== true), `${id}: compaction-basic`);
    assert.ok(group.config.some((row) => row.name === "@deepseek-ai/dsh-command-compact" && row.disabled !== true), `${id}: command-compact`);
  }
});

/** The compaction group of the real minimal/standard presets, or its shape when no host is given. */
async function presetGroups() {
  if (WEB_HOST === undefined) {
    return [["inline", {
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner" },
      ],
    }]];
  }
  const { all } = await composeWeb(WEB_HOST);
  return PRESETS.map((id) => [id, all.find((row) => row.id === id).config.plugins.find((row) => row.id === "compaction")]);
}

/**
 * Mount one preset compaction group as the preset registry does: its rows in
 * their own isolated realm, found again by `agentPresets.serviceFor`.
 */
async function mountPresetGroup(dsh, group) {
  await dsh.ctx.plugin(TokenMeter).await?.();
  let realm = dsh.ctx;
  for (const [name, isolated] of Object.entries(group.isolate ?? {})) if (isolated) realm = realm.isolate(name);
  for (const row of group.config) {
    if (row.disabled === true || row.name === "@deepseek-ai/dsh-command-compact") continue;
    const module = await import(row.name);
    await realm.plugin(module.default ?? module, row.config ?? {}).await?.();
  }
  dsh.ctx.reflect.provide("agentPresets", { serviceFor: (_agent, name) => realm.get(name) });
  return realm;
}

for (const [id, group] of await presetGroups()) {
  test(`${id}: without the Spine engine, the preset's compaction-basic rewrites the surface behind Spine (control)`, async () => {
    const dsh = await mountCompact(["first", overflow, "unused"], {}, []);
    try {
      await mountPresetGroup(dsh, group);
      const agent = await dsh.run("hello");
      await dsh.send(agent, "second");
      const types = agent.session.snapshotEvents().map((event) => event.type);
      assert.ok(types.includes("compaction/start"), "the preset engine compacted the session");
      assert.equal(checkpoints(agent).length, 0);
    } finally {
      await dsh.dispose();
    }
  });

  test(`${id}: the preset's compaction seam and pruner are bound to Spine; overflow and /compact checkpoint at a Spine barrier`, async () => {
    const dsh = await mountCompact([
      [["spine_open", { goal: "tool work" }]], "first",
      overflow, summary("SUMMARY FROM SPINE"), "recovered",
      summary("MANUAL SUMMARY"), "after manual",
    ]);
    try {
      const realm = await mountPresetGroup(dsh, group);
      const engine = realm.get("compaction");
      const pruner = realm.get("toolResultPruner");
      assert.notEqual(engine, dsh.ctx.compaction, "the preset has its own isolated engine");
      const agent = await dsh.run("hello");
      await dsh.send(agent, "second");
      assert.deepEqual(ends(agent), ["completed", "completed"]);
      assert.equal(checkpoints(agent).length, 1);
      assert.match(text(dsh.adapter.requests.at(-1)), /SUMMARY FROM SPINE/);
      if (pruner !== undefined) assert.deepEqual(pruner.pruneSession(agent.session).pruned, []);
      // The preset's /compact (dsh-command-compact) calls exactly this.
      const result = await engine.compactNow(agent, new AbortController().signal);
      assert.equal(result.summarySeq, checkpoints(agent).at(-1).seq);
      await dsh.send(agent, "third");
      assert.equal(ends(agent).at(-1), "completed");
      assert.match(text(dsh.adapter.requests.at(-1)), /MANUAL SUMMARY[^]*third/);
      const events = agent.session.snapshotEvents();
      assert.equal(events.filter((event) => event.type === "compaction/start").length, 0, "no preset compaction transaction");
      assert.equal(events.filter((event) => event.type === "tool/result" && event.surfaceOp !== undefined && event.surfaceOp !== "append").length, 0,
        "no pruned tool result replacement");

      // Unloading the Spine engine gives the preset its own seam back.
      await dsh.ctx.loader.resolve("spinejit-compact").update({ disabled: true });
      assert.equal(Object.hasOwn(engine, "compactNow"), false);
      if (pruner !== undefined) assert.equal(Object.hasOwn(pruner, "pruneSession"), false);
    } finally {
      await dsh.dispose();
    }
  });
}

test("session/list summaries leave out the Spine tree", async () => {
  const dsh = await mountCompact(["answer"]);
  try {
    const { treeProjection } = await import("../dist/display.js");
    assert.equal(treeProjection.wire.summary, false);
    await dsh.run("hello");
    const projections = dsh.ctx.sessionProjections;
    if (typeof projections.summaryKeys === "function") {
      // DSH 0.2.2+: session/list carries only these keys.
      assert.equal(projections.summaryKeys().has(treeProjection.key), false);
    }
  } finally {
    await dsh.dispose();
  }
});
