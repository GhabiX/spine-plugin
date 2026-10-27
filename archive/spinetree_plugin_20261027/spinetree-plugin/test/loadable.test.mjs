import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SpinePluginHost } from "@spinejit/spine-host";
import { createPiSessionAdapter } from "@spinejit/spine-host/pi";

import {
  createSpineTreePlugin,
  MemorySpineTreeMailbox,
  MemorySpineTreeStore,
  MemoryAgentRegistry,
  migrateSpineTreeLoad,
  SPINETREE_LOADABLE_PLUGINS,
  SPINETREE_PLUGIN_MANIFEST,
  SpineTreeLoadError,
} from "../dist/index.js";

const canonicalPlugin = {
  manifest: { schema: "spine-host/v1", id: "@spinejit/pi-spinejit", version: "0.1.0", owns: ["spine.canonical"] },
  activate() {},
};

test("declares version, dependency, capability, namespace, and migration for each loadable plugin", () => {
  assert.deepEqual(SPINETREE_LOADABLE_PLUGINS.map(plugin => plugin.id), [
    "@spinetree/project",
    "@spinetree/collaboration",
    "@spinetree/pi-adapter",
    "@spinejit/spinetree-navigation",
  ]);
  for (const plugin of SPINETREE_LOADABLE_PLUGINS) {
    assert.equal(plugin.schema, "spinetree.loadable/v1");
    assert.equal(plugin.version, "0.1.0");
    assert.equal(plugin.requires.length > 0, true);
    assert.equal(plugin.capability.startsWith("spinetree."), true);
    assert.equal(plugin.migration.length > 0, true);
  }
  assert.equal(SPINETREE_LOADABLE_PLUGINS[0].namespace, "spinetree");
  assert.equal(SPINETREE_LOADABLE_PLUGINS[1].namespace, "spinetree");
  assert.equal(SPINETREE_LOADABLE_PLUGINS[2].namespace, null);
  assert.equal(SPINETREE_LOADABLE_PLUGINS[3].namespace, "spine-tree");
  assert.deepEqual(migrateSpineTreeLoad(), ["@spinetree/project", "@spinetree/collaboration"]);
  assert.equal(createSpineTreePlugin().manifest, SPINETREE_PLUGIN_MANIFEST);
});

test("feature-off loads no tools and does not claim the spinetree namespace", async () => {
  const plugin = createSpineTreePlugin({ load: [] });
  assert.equal(plugin.manifest.toolNamespace, undefined);
  assert.deepEqual(plugin.manifest.owns, []);
  const host = new SpinePluginHost();
  host.register(canonicalPlugin);
  host.register(plugin);
  await host.activateAll();
  assert.deepEqual(host.listTools(), []);
  assert.deepEqual(host.listCommands(), []);
  await host.dispose();
});

test("project can load without collaboration, and a missing dependency does not register", async () => {
  assert.throws(
    () => createSpineTreePlugin({ load: ["@spinetree/collaboration"] }),
    error => error instanceof SpineTreeLoadError && error.code === "missing-dependency",
  );
  assert.throws(
    () => createSpineTreePlugin({ load: ["@spinetree/pi-adapter"] }),
    error => error instanceof SpineTreeLoadError && error.code === "missing-dependency",
  );
  const host = new SpinePluginHost();
  host.register(canonicalPlugin);
  host.register(createSpineTreePlugin({
    load: ["@spinetree/project"],
    store: new MemorySpineTreeStore({ schema: "spinetree.snapshot/v2", branches: {} }),
  }));
  await host.activateAll();
  assert.deepEqual(host.listTools(), ["spinetree_change", "spinetree_read", "spinetree_rejuvenate"]);
  await assert.rejects(host.executeTool("spinetree_send", { to: "agent", message: "hello" }), { code: "unknown-tool" });
  await host.dispose();
  assert.deepEqual(host.listTools(), []);
  await assert.rejects(host.executeTool("spinetree_read", {}), { code: "unknown-tool" });
});

test("collaboration keeps the shared namespace and dispose removes its tools", async () => {
  let disposed = false;
  const plugin = createSpineTreePlugin({
    load: ["@spinetree/project", "@spinetree/collaboration", "@spinetree/pi-adapter"],
    registry: new MemoryAgentRegistry(),
    mailbox: new MemorySpineTreeMailbox(),
  });
  assert.deepEqual(plugin.manifest.owns, ["spinetree.project-state", "spinetree.mailbox"]);
  assert.equal(plugin.manifest.toolNamespace, "spinetree");
  const host = new SpinePluginHost({ sessions: createPiSessionAdapter(() => undefined) });
  host.register(canonicalPlugin);
  host.register({
    ...plugin,
    dispose() {
      disposed = true;
      plugin.dispose();
    },
  });
  await host.activateAll();
  assert.deepEqual(host.listTools(), [
    "spinetree_change", "spinetree_observe", "spinetree_read", "spinetree_rejuvenate", "spinetree_send",
  ]);
  await host.dispose();
  assert.equal(disposed, true);
  assert.deepEqual(host.listTools(), []);
});

test("navigation remains a separate Pi extension package", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const navigation = JSON.parse(readFileSync(join(root, "../../spinetree-navigation/package.json"), "utf8"));
  const adapter = JSON.parse(readFileSync(join(root, "../../host/package.json"), "utf8"));
  assert.deepEqual(navigation.pi.extensions, ["./src/extension.ts"]);
  assert.equal(navigation.version, "0.1.0");
  assert.equal(adapter.exports["./pi"].import, "./dist/pi.js");
});
